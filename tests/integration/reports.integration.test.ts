import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { backfillDecisionReports, saveDecisionReport } from "../../apps/server/src/modules/reports/service.js";
import { buildApp } from "../../apps/server/src/app.js";
const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;
beforeEach(async () => { await pool.query("TRUNCATE simulations CASCADE"); simulationId = (await createSimulation(db)).id; });
afterAll(() => pool.end());
async function decision(result: unknown, failure: string | null = null) {
  return (await pool.query("INSERT INTO decisions(simulation_id,request_id,run_generation,configuration_version,prompt_version,input_snapshot,result,failure) VALUES($1,$2,0,1,1,$3,$4,$5) RETURNING id", [simulationId, crypto.randomUUID(), { market: [], capturedAt: new Date().toISOString() }, result, failure])).rows[0].id;
}
describe("saved trading evidence reports", () => {
  it("saves one immutable HOLD report even with concurrent recovery", async () => {
    const id = await decision({ decision: { action: "hold", explanation: "Insufficient edge after fees" } });
    await Promise.all([saveDecisionReport(pool, id), saveDecisionReport(pool, id)]);
    await backfillDecisionReports(pool);
    const rows = (await pool.query("SELECT payload FROM operational_events WHERE kind='decision_report'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ schemaVersion: 1, decisionId: id, outcome: "hold", sessionId: null, metrics: { fees: "0", realizedProfitNetOfTradingFees: "0", filledOrders: 0 }, configuration: { values: { feeRate: "0.0035" } } });
    await pool.query("UPDATE configurations SET values='{}' WHERE simulation_id=$1", [simulationId]);
    await saveDecisionReport(pool, id);
    expect((await pool.query("SELECT payload FROM operational_events WHERE kind='decision_report'")).rows[0].payload).toEqual(rows[0].payload);
  });
  it("recovers failed decisions, skips pending work, and exports through local-only routes", async () => {
    await decision(null);
    const id = await decision(null, "Provider timeout");
    await backfillDecisionReports(pool);
    const app = buildApp(pool);
    const headers = { host: "127.0.0.1:3000" };
    try {
      const response = await app.inject({ method: "GET", url: `/api/reports?simulationId=${simulationId}`, headers });
      expect(response.json()).toHaveLength(1);
      const reportId = response.json()[0].id;
      const report = await app.inject({ method: "GET", url: `/api/reports/${reportId}`, headers });
      expect(report.json()).toMatchObject({ decisionId: id, outcome: "failed", decision: { failure: "Provider timeout" } });
      expect(report.headers['content-disposition']).toContain('.json');
      expect((await app.inject({ method: "GET", url: `/api/reports/${reportId}`, headers: { ...headers, origin: "https://evil.example" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: '/api/reports?limit=200', headers })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/reports/${crypto.randomUUID()}`, headers })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it("reports realized sell profit without subtracting fees twice", async () => {
    const id = await decision({ decision: { action: "sell", symbol: "BTCUSDT", quantity: "1" } });
    const order = (await pool.query("INSERT INTO orders(simulation_id,decision_id,symbol,side,quantity,status) VALUES($1,$2,'BTCUSDT','sell',1,'filled') RETURNING id", [simulationId, id])).rows[0].id;
    const fill = (await pool.query("INSERT INTO fills(simulation_id,order_id,symbol,side,quantity,price,fee) VALUES($1,$2,'BTCUSDT','sell',1,110,0.385) RETURNING id", [simulationId, order])).rows[0].id;
    await pool.query("INSERT INTO ledger_entries(simulation_id,fill_id,asset,amount,kind) VALUES($1,$2,'USDT',9.265,'realized_profit'),($1,$2,'USDT',-0.385,'fee')", [simulationId, fill]);
    await saveDecisionReport(pool, id);
    const report = (await pool.query("SELECT payload FROM operational_events WHERE kind='decision_report'")).rows[0].payload;
    expect(Number(report.metrics.realizedProfitNetOfTradingFees)).toBe(9.265);
    expect(Number(report.metrics.fees)).toBe(0.385);
    expect(report.fills).toHaveLength(1);
    expect(report.ledger).toHaveLength(2);
  });
});

it("filters by evaluation date, hides deleted reports, and restores them without rebuilding", async () => {
  const id = await decision({ decision: { action: "hold" } });
  await pool.query("UPDATE decisions SET created_at='2026-11-10T15:00:00Z' WHERE id=$1", [id]);
  await saveDecisionReport(pool, id);
  const reportId = (await pool.query("SELECT id FROM operational_events WHERE kind='decision_report'")).rows[0].id;
  const app = buildApp(pool);
  const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
  try {
    const list = async (query = '') => (await app.inject({ method: 'GET', url: `/api/reports?simulationId=${simulationId}${query}`, headers })).json();
    expect(await list('&from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z')).toHaveLength(1);
    expect(await list('&from=2026-11-11T00:00:00Z')).toHaveLength(0);
    expect(await list('&to=2026-11-10T15:00:00Z')).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/reports?from=2026-11-11T00:00:00Z&to=2026-11-10T00:00:00Z', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/reports/${reportId}`, headers: { host: headers.host, 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/reports/${reportId}`, headers, payload: {} })).statusCode).toBe(200);
    await backfillDecisionReports(pool);
    expect(await list()).toHaveLength(0);
    expect(await list('&deleted=true')).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/reports/${reportId}`, headers })).statusCode).toBe(404);
    expect((await pool.query('SELECT id FROM decisions WHERE id=$1', [id])).rowCount).toBe(1);
    expect((await app.inject({ method: 'POST', url: `/api/reports/${reportId}/restore`, headers, payload: {} })).statusCode).toBe(200);
    expect(await list()).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM operational_events WHERE kind LIKE 'decision_report%'" )).rows[0].count).toBe(1);
  } finally { await app.close(); }
});
