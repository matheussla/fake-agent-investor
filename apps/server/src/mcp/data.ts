import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { catalog, columns, type Dataset, type DatasetName } from "./catalog.js";

export class AnalysisError extends Error {}
const datasetSchema = z.enum(Object.keys(catalog) as [DatasetName, ...DatasetName[]]);
export const listSchema = z.object({
  dataset: datasetSchema,
  simulationId: z.string().uuid().optional(),
  symbol: z.string().regex(/^[A-Z0-9]{2,20}USDT$/).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  outcome: z.enum(["buy", "sell", "hold", "failed", "unknown"]).optional(),
  sessionId: z.string().uuid().optional(),
  includeDeleted: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(2048).optional(),
}).strict();
export const recordSchema = z.object({
  dataset: datasetSchema, id: z.string().uuid(), includeDeleted: z.boolean().default(false),
  offset: z.number().int().min(0).default(0), length: z.number().int().min(2).max(16000).default(16000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const snapshotSchema = z.object({ simulationId: z.string().uuid() }).strict();

export async function readOnly<T>(pool: Pool, query: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await query(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Destroy a connection after rollback failure rather than reuse a broken transaction.
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cursorSchema = z.object({ scope: z.string(), id: z.string().uuid() }).strict();
const recordObject = z.record(z.string(), z.unknown());
export const listOutputSchema = z.object({ schemaVersion: z.literal(1), dataset: datasetSchema, observedAt: z.string(), scope: recordObject, records: z.array(recordObject), omittedFields: z.array(z.string()), nextCursor: z.string().nullable() });
export const recordOutputSchema = z.object({ schemaVersion: z.literal(1), dataset: datasetSchema, id: z.string(), observedAt: z.string(), sha256: z.string(), encoding: z.literal("json/utf-16-code-units"), offset: z.number(), totalLength: z.number(), nextOffset: z.number().nullable(), jsonChunk: z.string() });
export const snapshotOutputSchema = z.object({ schemaVersion: z.literal(1), observedAt: z.string(), simulation: recordObject, state: recordObject.nullable(), cash: z.string(), realizedProfit: z.string(), latestEquity: recordObject.nullable(), positionsDataset: z.literal("positions") });

export class AnalysisData {
  constructor(private readonly pool: Pool) {}

  async list(input: unknown): Promise<z.infer<typeof listOutputSchema>> {
    const parsed = listSchema.parse(input);
    const { dataset, limit, cursor, ...scope } = parsed;
    const definition: Dataset = catalog[dataset];
    if ((scope.simulationId && !definition.simulation) || (scope.symbol && !definition.symbol) || ((scope.outcome || scope.sessionId || scope.includeDeleted) && dataset !== "reports")) throw new AnalysisError("Unsupported filter for this dataset; consult the data dictionary.");
    const fingerprint = hash(JSON.stringify({ dataset, ...scope }));
    let after: string | undefined;
    if (cursor) {
      try {
        const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        if (decoded.scope !== fingerprint) throw new Error();
        after = decoded.id;
      } catch { throw new AnalysisError("Cursor is invalid or belongs to different filters."); }
    }
    const values: unknown[] = [];
    const conditions = [definition.where ?? "true"];
    const filter = (expression: string, value: unknown) => { values.push(value); conditions.push(`${expression} $${values.length}`); };
    if (dataset === "reports" && !scope.includeDeleted) conditions.push("kind='decision_report'");
    if (scope.simulationId) filter(`${definition.simulation} =`, scope.simulationId);
    if (scope.symbol) filter(`${definition.symbol} =`, scope.symbol);
    if (scope.from) filter(`${definition.time} >=`, scope.from);
    if (scope.to) filter(`${definition.time} <`, scope.to);
    if (scope.outcome) filter("payload->>'outcome' =", scope.outcome);
    if (scope.sessionId) filter("payload->>'sessionId' =", scope.sessionId);
    if (after) filter("t.id >", after);
    values.push(limit + 1);
    // UUID keysets avoid timestamp truncation and equal-timestamp gaps. Lists are not chronological.
    const reportSummary = dataset === "reports" ? ",payload->>'outcome' AS outcome,payload->>'startedAt' AS started_at,payload->>'decisionId' AS decision_id,payload->>'sessionId' AS session_id,payload->'metrics' AS metrics" : "";
    const rows = await readOnly(this.pool, async client => {
      // Validate with PostgreSQL precision; JavaScript Date would discard microseconds.
      if (scope.from && scope.to && !(await client.query("SELECT $1::timestamptz < $2::timestamptz AS valid", [scope.from, scope.to])).rows[0].valid) throw new AnalysisError("from must precede to.");
      return (await client.query(`SELECT ${columns(definition, true)}${reportSummary} FROM ${definition.table} t WHERE ${conditions.join(" AND ")} ORDER BY t.id LIMIT $${values.length}`, values)).rows as Record<string, unknown>[];
    });
    const more = rows.length > limit;
    const records = rows.slice(0, limit);
    const nextCursor = more ? Buffer.from(JSON.stringify({ scope: fingerprint, id: records.at(-1)!.id })).toString("base64url") : null;
    return { schemaVersion: 1, dataset, observedAt: new Date().toISOString(), scope, records, omittedFields: definition.omit ?? [], nextCursor };
  }

  async record(input: unknown): Promise<z.infer<typeof recordOutputSchema>> {
    const { dataset, id, includeDeleted, offset, length, expectedHash } = recordSchema.parse(input);
    if (includeDeleted && dataset !== "reports") throw new AnalysisError("Unsupported deleted filter for this dataset.");
    const definition: Dataset = catalog[dataset];
    const visible = dataset === "reports" && !includeDeleted ? "AND kind='decision_report'" : "";
    const row = await readOnly(this.pool, async client => (await client.query(`SELECT ${columns(definition)} FROM ${definition.table} t WHERE t.id=$1 AND (${definition.where ?? "true"}) ${visible}`, [id])).rows[0]);
    if (!row) throw new AnalysisError("Record not found or not visible.");
    const json = JSON.stringify(row);
    const sha256 = hash(json);
    if (expectedHash && sha256 !== expectedHash) throw new AnalysisError("Record changed; restart retrieval at offset 0.");
    if (offset > 0 && !expectedHash) throw new AnalysisError("expectedHash is required for continuation chunks.");
    if (offset > json.length) throw new AnalysisError("Offset exceeds record length.");
    const splitsPair = (index: number) => /[\uD800-\uDBFF]/.test(json.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(json.charAt(index));
    if (splitsPair(offset)) throw new AnalysisError("Offset splits a Unicode character; use nextOffset from the previous chunk.");
    let end = Math.min(offset + length, json.length);
    if (splitsPair(end)) end--;
    return { schemaVersion: 1, dataset, id, observedAt: new Date().toISOString(), sha256, encoding: "json/utf-16-code-units", offset, totalLength: json.length, nextOffset: end < json.length ? end : null, jsonChunk: json.slice(offset, end) };
  }

  async snapshot(input: unknown): Promise<z.infer<typeof snapshotOutputSchema>> {
    const { simulationId } = snapshotSchema.parse(input);
    return readOnly(this.pool, async client => {
      const simulation = (await client.query(`SELECT ${columns(catalog.simulations)} FROM simulations t WHERE id=$1`, [simulationId])).rows[0];
      if (!simulation) throw new AnalysisError("Simulation not found.");
      const state = (await client.query("SELECT paused,generation,cycle_running,pause_reason,consecutive_failures FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0] ?? null;
      const ledger = (await client.query("SELECT COALESCE(sum(amount) FILTER (WHERE kind IN ('initial_funding','trade_cash','fee')),0)::text AS cash, COALESCE(sum(amount) FILTER (WHERE kind='realized_profit'),0)::text AS profit FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT'", [simulationId])).rows[0];
      const latestEquity = (await client.query(`SELECT ${columns(catalog.equity)} FROM equity_history t WHERE simulation_id=$1 ORDER BY observed_at DESC LIMIT 1`, [simulationId])).rows[0] ?? null;
      return { schemaVersion: 1, observedAt: new Date().toISOString(), simulation, state, cash: ledger.cash, realizedProfit: ledger.profit, latestEquity, positionsDataset: "positions" };
    });
  }
}
