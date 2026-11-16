import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/api/health", async () => ({ status: "ok", modules: { database: "unavailable", market: "unavailable" } }));
  return app;
}
