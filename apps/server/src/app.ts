import { registerReportRoutes } from "./http/report-routes.js";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { EventHub } from "./http/sse.js";
import { registerReadRoutes } from "./http/read-routes.js";
import { registerMarketRoutes } from "./http/market-routes.js";
import { registerControlRoutes } from "./http/control-routes.js";
import { registerTeamRoutes } from "./http/team-routes.js";
import type { TeamRuntime } from "./modules/team/runtime.js";
import type { AgentService } from "./modules/agent/service.js";
import type { createDatabase } from "./db/client.js";

type Database = ReturnType<typeof createDatabase>["db"];

export function buildApp(pool?: Pool, events = new EventHub(), controls?: { db: Database; agent: AgentService; team?: TeamRuntime }): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok" }));
  if (pool) registerReadRoutes(app, pool, events, controls?.agent);
  if (pool) registerMarketRoutes(app);
  if (pool) registerReportRoutes(app, pool);
  if (pool && controls) registerControlRoutes(app, { pool, ...controls });
  if (pool && controls?.team) registerTeamRoutes(app, pool, controls.team, events);
  return app;
}
