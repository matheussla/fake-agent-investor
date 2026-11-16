import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { isSameOriginLocal } from "./origin.js";
import type { EventHub } from "./sse.js";

const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().datetime().optional(), simulationId: z.string().uuid().optional() }).strict();
const rangeSchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), simulationId: z.string().uuid().optional() }).strict();

export function registerReadRoutes(app: FastifyInstance, pool: Pool, events: EventHub): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!isSameOriginLocal(request)) return reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "Local same-origin request required" } });
  });
  const active = async (simulationId?: string) => {
    if (simulationId) return simulationId;
    const result = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
    return result.rows[0]?.id as string | undefined;
  };
  const paged = async (request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }, query: (id: string, limit: number, before?: string) => Promise<unknown>) => {
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: parsed.error.issues[0]?.message } });
    const id = await active(parsed.data.simulationId);
    if (!id) return [];
    return query(id, parsed.data.limit, parsed.data.before);
  };

  app.get("/api/portfolio", async (request, reply) => paged(request, reply, async (id) => {
    const [cash, positions, latest, realized, stalePositions] = await Promise.all([
      pool.query("SELECT COALESCE(sum(amount) FILTER (WHERE kind IN ('initial_funding','trade_cash','fee')),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT'", [id]),
      pool.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity<>0 ORDER BY symbol", [id]),
      pool.query("SELECT equity::text,observed_at FROM equity_history WHERE simulation_id=$1 ORDER BY observed_at DESC LIMIT 1", [id]),
      pool.query("SELECT COALESCE(sum(amount),0)::text AS profit FROM ledger_entries WHERE simulation_id=$1 AND kind='realized_profit'", [id]),
      pool.query("SELECT EXISTS(SELECT 1 FROM positions p WHERE p.simulation_id=$1 AND p.quantity<>0 AND NOT EXISTS(SELECT 1 FROM quote_samples q WHERE q.symbol=p.symbol AND q.observed_at > now()-interval '5 seconds' AND q.received_at > now()-interval '5 seconds')) AS stale", [id]),
    ]);
    const age = latest.rows[0] ? Date.now() - Date.parse(latest.rows[0].observed_at) : Infinity;
    const dataStatus = !latest.rows[0] ? "unavailable" : stalePositions.rows[0].stale || age > 65_000 ? "stale" : "available";
    return { simulationId: id, cash: cash.rows[0].cash, positions: positions.rows, equity: latest.rows[0]?.equity ?? null, equityObservedAt: latest.rows[0]?.observed_at ?? null, realizedProfit: realized.rows[0].profit, dataStatus };
  }));
  app.get("/api/positions", async (request, reply) => paged(request, reply, async (id) => (await pool.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity<>0 ORDER BY symbol", [id])).rows));
  app.get("/api/equity", async (request, reply) => {
    const parsed = rangeSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: parsed.error.issues[0]?.message } });
    const id = await active(parsed.data.simulationId); if (!id) return [];
    const result = await pool.query("SELECT cash::text,equity::text,realized_profit::text,unrealized_profit::text,observed_at FROM equity_history WHERE simulation_id=$1 AND ($2::timestamptz IS NULL OR observed_at >= $2) AND ($3::timestamptz IS NULL OR observed_at <= $3) ORDER BY observed_at DESC LIMIT 1000", [id, parsed.data.from ?? null, parsed.data.to ?? null]);
    return result.rows;
  });
  app.get("/api/markets", async (request, reply) => paged(request, reply, async (_id, limit, before) => (await pool.query("SELECT DISTINCT ON(symbol) symbol,bid::text,ask::text,bid_size::text AS \"bidSize\",ask_size::text AS \"askSize\",observed_at FROM quote_samples WHERE ($1::timestamptz IS NULL OR observed_at < $1) ORDER BY symbol,observed_at DESC LIMIT $2", [before ?? null, limit])).rows));
  app.get("/api/trades", async (request, reply) => paged(request, reply, async (id, limit, before) => (await pool.query("SELECT o.id,o.symbol,o.side,o.quantity::text,o.status,o.reason,o.created_at,f.price::text,f.fee::text FROM orders o LEFT JOIN fills f ON f.order_id=o.id WHERE o.simulation_id=$1 AND ($2::timestamptz IS NULL OR o.created_at < $2) ORDER BY o.created_at DESC LIMIT $3", [id, before ?? null, limit])).rows));
  app.get("/api/decisions", async (request, reply) => paged(request, reply, async (id, limit, before) => (await pool.query("SELECT id,request_id,result,failure,input_snapshot,created_at FROM decisions WHERE simulation_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT $3", [id, before ?? null, limit])).rows));
  app.get("/api/prompts", async (request, reply) => paged(request, reply, async (id, limit) => (await pool.query("SELECT id,name,version,content,active,created_at FROM prompts WHERE simulation_id=$1 ORDER BY name,version DESC LIMIT $2", [id, limit])).rows));
  app.get("/api/settings", async (request, reply) => paged(request, reply, async (id) => (await pool.query("SELECT version,values,created_at FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [id])).rows[0] ?? null));
  app.get("/api/health", async (_request, reply) => {
    let database: "healthy" | "unavailable" = "healthy";
    try { await pool.query("SELECT 1"); } catch { database = "unavailable"; }
    const simulation = await pool.query("SELECT id,status FROM simulations ORDER BY created_at DESC LIMIT 1").catch(() => ({ rows: [] }));
    return reply.code(database === "healthy" ? 200 : 503).send({ database, market: events.health(), provider: "unavailable", simulation: simulation.rows[0] ?? null });
  });
  app.get("/api/simulations", async () => (await pool.query("SELECT id,status,starting_cash::text,created_at,archived_at FROM simulations ORDER BY created_at DESC LIMIT 100")).rows);
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(`id: ${randomUUID()}\nevent: snapshot-required\ndata: {}\n\n`);
    let lastWrite = 0;
    const unsubscribe = events.subscribe((event) => {
      const now = Date.now();
      if (now - lastWrite < 1000) return;
      lastWrite = now;
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });
}
