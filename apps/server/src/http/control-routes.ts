import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { ActivatePromptBodySchema, EmptyControlBodySchema, NewSimulationBodySchema, PauseBodySchema, RunOnceBodySchema, SavePromptBodySchema, SettingsBodySchema } from "@paper-investor/contracts/http";
import { createDatabase } from "../db/client.js";
import { AgentService } from "../modules/agent/service.js";
import { activatePromptVersion, savePrompt } from "../modules/prompts/service.js";
import { updateSettings } from "../modules/settings/service.js";
import { resetSimulation } from "../modules/simulations/service.js";
import { isSameOriginMutation } from "./origin.js";

type Database = ReturnType<typeof createDatabase>["db"];
interface ControlDependencies { pool: Pool; db: Database; agent: AgentService; }

export function registerControlRoutes(app: FastifyInstance, { pool, db, agent }: ControlDependencies): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!isSameOriginMutation(request)) return reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "Explicit same-origin JSON request required" } });
  });

  const activeSimulationId = async () => {
    const result = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
    if (!result.rowCount) throw new Error("No active simulation");
    return result.rows[0].id as string;
  };

  app.post("/api/agent/start", async (request, reply) => {
    const body = EmptyControlBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try { return await agent.startAgent(); }
    catch (error) { return sendError(reply, error); }
  });
  app.post("/api/agent/pause", async (request, reply) => {
    const body = PauseBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try { return await agent.pauseAgent(body.data.reason); }
    catch (error) { return sendError(reply, error); }
  });
  app.post("/api/agent/run-once", async (request, reply) => {
    const body = RunOnceBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try { return reply.code(202).send(await agent.enqueueRunOnce(body.data.requestId)); }
    catch (error) { return sendError(reply, error); }
  });
  app.post("/api/prompts", async (request, reply) => {
    const body = SavePromptBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try { return reply.code(201).send(await savePrompt(db, { ...body.data, simulationId: await activeSimulationId() })); }
    catch (error) { return sendError(reply, error); }
  });
  app.post("/api/prompts/:promptId/activate", async (request, reply) => {
    const params = z.object({ promptId: z.string().uuid() }).safeParse(request.params);
    const body = ActivatePromptBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      await activatePromptVersion(db, params.data.promptId, body.data.promptVersionId);
      return { activated: true };
    } catch (error) { return sendError(reply, error); }
  });
  app.patch("/api/settings", async (request, reply) => {
    const body = SettingsBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try { return await updateSettings(db, { ...body.data, simulationId: await activeSimulationId() }); }
    catch (error) { return sendError(reply, error); }
  });
  app.post("/api/simulations", async (request, reply) => {
    const body = NewSimulationBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try { return reply.code(201).send(await resetSimulation(db, body.data)); }
    catch (error) { return sendError(reply, error); }
  });
}

function invalid(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Request body does not match the required schema" } });
}

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  const code = message.includes("allowance exhausted") ? "ALLOWANCE_EXHAUSTED" : message.includes("conflict") ? "VERSION_CONFLICT" : message.includes("Invalid") ? "INVALID_INPUT" : message.includes("active simulation") || message.includes("unavailable") ? "DEPENDENCY_UNAVAILABLE" : "STATE_CONFLICT";
  const status = code === "ALLOWANCE_EXHAUSTED" ? 429 : code === "DEPENDENCY_UNAVAILABLE" ? 503 : code === "INVALID_INPUT" ? 400 : code === "STATE_CONFLICT" || code === "VERSION_CONFLICT" ? 409 : 503;
  return reply.code(status).send({ error: { code, message: code === "INVALID_INPUT" ? "Request could not be validated" : code === "ALLOWANCE_EXHAUSTED" ? "Daily provider allowance exhausted" : code === "DEPENDENCY_UNAVAILABLE" ? "A required service is unavailable" : "Request conflicts with the current simulation state" } });
}
