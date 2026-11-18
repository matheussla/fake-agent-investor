import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { isSameOriginMutation } from "./origin.js";
import { z } from "zod";

export function registerReportRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/api/reports", async (request, reply) => {
    const query = z.object({ simulationId: z.string().uuid().optional(), before: z.string().datetime().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), deleted: z.enum(["true", "false"]).default("false"), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(request.query);
    if (!query.success || (query.data.from && query.data.to && Date.parse(query.data.from) >= Date.parse(query.data.to))) return reply.code(400).send({ error: "Invalid report query" });
    const rows = await pool.query("SELECT id,simulation_id,created_at,payload->>'startedAt' AS started_at,(kind='decision_report_deleted') AS deleted,payload->>'decisionId' AS decision_id,payload->>'sessionId' AS session_id,payload->>'outcome' AS outcome,payload->'metrics' AS metrics FROM operational_events WHERE kind=$6 AND ($4::timestamptz IS NULL OR (payload->>'startedAt')::timestamptz >= $4) AND ($5::timestamptz IS NULL OR (payload->>'startedAt')::timestamptz < $5) AND ($1::uuid IS NULL OR simulation_id=$1) AND ($2::timestamptz IS NULL OR created_at<$2) ORDER BY created_at DESC,id DESC LIMIT $3", [query.data.simulationId ?? null, query.data.before ?? null, query.data.limit, query.data.from ?? null, query.data.to ?? null, query.data.deleted === "true" ? "decision_report_deleted" : "decision_report"]);
    return rows.rows;
  });
  app.get("/api/reports/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid report ID" });
    const row = (await pool.query("SELECT payload FROM operational_events WHERE id=$1 AND kind='decision_report'", [params.data.id])).rows[0];
    if (!row) return reply.code(404).send({ error: "Report not found" });
    return reply.header("Content-Disposition", `attachment; filename="trading-report-${params.data.id}.json"`).send(row.payload);
  });
  for (const restore of [false, true]) {
    app.route({ method: restore ? "POST" : "DELETE", url: restore ? "/api/reports/:id/restore" : "/api/reports/:id", handler: async (request, reply) => {
      if (!isSameOriginMutation(request)) return reply.code(403).send({ error: { message: "Local same-origin JSON request required" } });
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success || !z.object({}).strict().safeParse(request.body).success) return reply.code(400).send({ error: { message: "Invalid report request" } });
      const kind = restore ? "decision_report" : "decision_report_deleted";
      const result = await pool.query("UPDATE operational_events SET kind=$2 WHERE id=$1 AND kind IN ('decision_report','decision_report_deleted') RETURNING id", [params.data.id, kind]);
      if (!result.rowCount) return reply.code(404).send({ error: { message: "Report not found" } });
      return { id: params.data.id, deleted: !restore };
    } });
  }
  app.get("/api/trading-sessions", async (request, reply) => {
    const query = z.object({ simulationId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid session query" });
    return (await pool.query("SELECT id,kind,payload,created_at FROM operational_events WHERE simulation_id=$1 AND kind IN ('session_started','session_stopped') ORDER BY created_at DESC,id DESC LIMIT $2", [query.data.simulationId, query.data.limit])).rows;
  });
}
