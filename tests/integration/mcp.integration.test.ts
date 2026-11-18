import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { AnalysisData, readOnly } from "../../apps/server/src/mcp/data.js";
const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
const data = new AnalysisData(pool);
let simulationId: string;
beforeEach(async () => { await pool.query("TRUNCATE simulations CASCADE"); simulationId = (await createSimulation(db)).id; });
afterAll(() => pool.end());

it("traverses equal timestamps without losing records and binds cursors to filters", async () => {
  await pool.query("INSERT INTO operational_events(simulation_id,kind,payload,created_at) SELECT $1,'session_started','{}','2026-11-18T00:00:00.123456Z' FROM generate_series(1,3)", [simulationId]);
  const first = await data.list({ dataset: "sessions", simulationId, limit: 2 });
  expect(first.records).toHaveLength(2);
  const second = await data.list({ dataset: "sessions", simulationId, limit: 2, cursor: first.nextCursor! });
  expect(second.records).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.records, ...second.records].map(r => r.id)).size).toBe(3);
  await expect(data.list({ dataset: "sessions", cursor: first.nextCursor! })).rejects.toThrow("Cursor");
});
it("filters reports and requires explicit deleted access, including direct retrieval", async () => {
  const ids = (await pool.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'decision_report',$2),($1,'decision_report_deleted',$2) RETURNING id", [simulationId, { startedAt: "2026-11-10T00:00:00Z", outcome: "hold", metrics: { fees: "0.000000000000000001" } }])).rows;
  expect((await data.list({ dataset: "reports", simulationId, outcome: "hold", from: "2026-11-10T00:00:00Z", to: "2026-11-11T00:00:00Z" })).records).toHaveLength(1);
  expect((await data.list({ dataset: "reports", from: "2026-11-11T00:00:00Z" })).records).toHaveLength(0);
  await expect(data.record({ dataset: "reports", id: ids[1].id })).rejects.toThrow("not found");
  const deleted = await data.record({ dataset: "reports", id: ids[1].id, includeDeleted: true });
  expect(JSON.parse(deleted.jsonChunk).kind).toBe("decision_report_deleted");
  expect(deleted.jsonChunk).toContain('0.000000000000000001');
});
it("reconstructs large evidence in bounded chunks and detects changed records", async () => {
  const id = (await pool.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'decision_report',$2) RETURNING id", [simulationId, { message: "é🤖".repeat(10000) }])).rows[0].id;
  let part = await data.record({ dataset: "reports", id, length: 10000 });
  let json = part.jsonChunk;
  while (part.nextOffset !== null) { part = await data.record({ dataset: "reports", id, offset: part.nextOffset, length: 10000, expectedHash: part.sha256 }); json += part.jsonChunk; }
  expect(JSON.parse(json).payload.message).toBe("é🤖".repeat(10000));
  await pool.query("UPDATE operational_events SET payload='{}' WHERE id=$1", [id]);
  await expect(data.record({ dataset: "reports", id, expectedHash: part.sha256 })).rejects.toThrow("changed");
});
it("preserves decimal precision and reads archived simulations", async () => {
  await pool.query("UPDATE simulations SET status='archived',starting_cash=123.123456789123456789 WHERE id=$1", [simulationId]);
  const result = await data.record({ dataset: "simulations", id: simulationId });
  expect(JSON.parse(result.jsonChunk).starting_cash).toBe("123.123456789123456789");
  expect((await data.list({ dataset: "simulations" })).records).toHaveLength(1);
  const snapshot = await data.snapshot({ simulationId });
  expect(snapshot.simulation.status).toBe("archived");
  expect(snapshot.cash).toBe("10000.000000000000000000");
});
it("rejects malformed requests, unsupported filters, SQL and missing records", async () => {
  await expect(data.list({ dataset: "reports", limit: 101 })).rejects.toThrow();
  await expect(data.list({ dataset: "reports", cursor: "bad" })).rejects.toThrow();
  await expect(data.list({ dataset: "reports", from: "2026-11-11T00:00:00Z", to: "2026-11-10T00:00:00Z" })).rejects.toThrow();
  await expect(data.list({ dataset: "simulations", symbol: "BTCUSDT" })).rejects.toThrow("Unsupported");
  await expect(data.list({ dataset: "simulations; DROP TABLE simulations" })).rejects.toThrow();
  await expect(data.record({ dataset: "reports", id: crypto.randomUUID() })).rejects.toThrow("not found");
});
it("enforces read-only transactions at PostgreSQL and releases failed connections", async () => {
  await expect(readOnly(pool, client => client.query("DELETE FROM simulations"))).rejects.toThrow(/read-only/);
  expect((await data.list({ dataset: "simulations" })).records).toHaveLength(1);
});

it("exposes every curated dataset with valid SQL and consistent scope", async () => {
  const { catalog } = await import("../../apps/server/src/mcp/catalog.js");
  for (const [dataset, definition] of Object.entries(catalog)) {
    const result = await data.list({ dataset, ...("simulation" in definition ? { simulationId } : {}) });
    expect(Array.isArray(result.records)).toBe(true);
    for (const record of result.records) {
      const full = await data.record({ dataset, id: record.id });
      expect(JSON.parse(full.jsonChunk).id).toBe(record.id);
    }
  }
});

it("uses UTC instants for daily usage filters and preserves microsecond ranges", async () => {
  const usageId = (await pool.query("INSERT INTO daily_usage(utc_date,provider,attempts) VALUES('2099-11-18',$1,1) RETURNING id", [crypto.randomUUID()])).rows[0].id;
  try {
    expect((await data.list({ dataset: "usage", from: "2099-11-18T12:00:00Z", to: "2099-11-19T00:00:00Z" })).records).toHaveLength(0);
    expect((await data.list({ dataset: "usage", from: "2099-11-18T00:00:00Z", to: "2099-11-18T12:00:00Z" })).records.map(r => r.id)).toContain(usageId);
    await pool.query("INSERT INTO operational_events(simulation_id,kind,payload,created_at) VALUES($1,'session_started','{}','2026-11-18T00:00:00.123456Z')", [simulationId]);
    expect((await data.list({ dataset: "sessions", simulationId, from: "2026-11-18T00:00:00.123456Z", to: "2026-11-18T00:00:00.123457Z" })).records).toHaveLength(1);
  } finally { await pool.query("DELETE FROM daily_usage WHERE id=$1", [usageId]); }
});
it("returns Unicode-safe chunks for clients using UTF-8", async () => {
  const id = (await pool.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'decision_report',$2) RETURNING id", [simulationId, { message: "🤖🤖🤖" }])).rows[0].id;
  let chunk = await data.record({ dataset: "reports", id, length: 2 });
  let full = "";
  for (;;) {
    expect(Buffer.from(chunk.jsonChunk, "utf8").toString("utf8")).toBe(chunk.jsonChunk);
    full += chunk.jsonChunk;
    if (chunk.nextOffset === null) break;
    chunk = await data.record({ dataset: "reports", id, length: 2, offset: chunk.nextOffset, expectedHash: chunk.sha256 });
  }
  expect(JSON.parse(full).payload.message).toBe("🤖🤖🤖");
});
