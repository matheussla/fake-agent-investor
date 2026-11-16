import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { EventHub } from "./http/sse.js";
import { registerReadRoutes } from "./http/read-routes.js";

export function buildApp(pool?: Pool, events = new EventHub()): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ status: "ok" }));
  if (pool) registerReadRoutes(app, pool, events);
  return app;
}
