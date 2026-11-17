import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { EventHub } from "./http/sse.js";
import { registerReadRoutes } from "./http/read-routes.js";
import { registerControlRoutes } from "./http/control-routes.js";
import type { AgentService } from "./modules/agent/service.js";
import type { createDatabase } from "./db/client.js";

type Database = ReturnType<typeof createDatabase>["db"];

export function buildApp(pool?: Pool, events = new EventHub(), controls?: { db: Database; agent: AgentService }): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok" }));
  if (pool) registerReadRoutes(app, pool, events);
  if (pool && controls) registerControlRoutes(app, { pool, ...controls });
  return app;
}
