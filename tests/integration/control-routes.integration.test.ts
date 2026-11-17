import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionInput, DecisionProvider, ExecutionProvider } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { AgentService } from "../../apps/server/src/modules/agent/service.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { EventHub } from "../../apps/server/src/http/sse.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
const requestHeaders = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "content-type": "application/json" };
let simulationId: string;
let agent: AgentService;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  await pool.query("TRUNCATE simulations CASCADE");
  await pool.query("TRUNCATE daily_usage");
  simulationId = (await createSimulation(db)).id;
  const provider: DecisionProvider = { decide: vi.fn(async (input: DecisionInput) => { void input; return { decision: { action: "hold", explanation: "No trade." } }; }) };
  const execution = { submit: vi.fn(async () => ({ status: "filled" as const, orderId: crypto.randomUUID() })) } as unknown as ExecutionProvider;
  agent = new AgentService({ pool, providers: { grok: provider }, execution });
  app = buildApp(pool, new EventHub(), { db, agent });
});
afterEach(async () => { await app.close(); await agent.close(); });
afterAll(async () => pool.end());

const post = (url: string, payload: unknown, method: "POST" | "PATCH" = "POST", headers = requestHeaders) => app.inject({ method, url, headers, payload });

describe("local simulation control routes", () => {
  it("runs lifecycle controls and acknowledges Run Once promptly", async () => {
    expect((await post("/api/agent/start", {})).statusCode).toBe(200);
    expect((await post("/api/agent/pause", { reason: "manual" })).statusCode).toBe(200);
    const requestId = "4edb23e3-a72d-4f5b-8b2a-f56da3288f2b";
    const response = await post("/api/agent/run-once", { requestId });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ requestId, status: "pending" });
    await vi.waitFor(async () => expect((await pool.query("SELECT result FROM decisions WHERE request_id=$1", [requestId])).rows[0].result).not.toBeNull());
  });

  it("saves and activates a version under its named prompt and rejects cross-prompt selection", async () => {
    const first = await post("/api/prompts", { name: "Momentum", content: "Initial" });
    const second = await post("/api/prompts", { name: "Momentum", content: "Updated" });
    const other = await post("/api/prompts", { name: "Value", content: "Another strategy" });
    expect(first.statusCode).toBe(201);
    expect(second.json().version).toBe(2);
    expect((await post(`/api/prompts/${first.json().id}/activate`, { promptVersionId: other.json().id })).statusCode).toBe(409);
    expect((await post(`/api/prompts/${first.json().id}/activate`, { promptVersionId: second.json().id })).statusCode).toBe(200);
    expect((await pool.query("SELECT version FROM prompts WHERE simulation_id=$1 AND active=true", [simulationId])).rows[0].version).toBe(2);
  });

  it("updates paused settings with optimistic versions and reports stale conflicts", async () => {
    const settings = (await app.inject({ method: "GET", url: "/api/settings", headers: requestHeaders })).json().values;
    const changed = { ...settings, provider: "codex" };
    expect((await post("/api/settings", { expectedVersion: 1, values: changed }, "PATCH")).statusCode).toBe(200);
    expect((await post("/api/settings", { expectedVersion: 1, values: settings }, "PATCH")).statusCode).toBe(409);
    await pool.query("UPDATE agent_state SET paused=false WHERE simulation_id=$1", [simulationId]);
    expect((await post("/api/settings", { expectedVersion: 2, values: changed }, "PATCH")).statusCode).toBe(409);
  });

  it("archives the prior simulation, preserves evidence, and makes reset idempotent", async () => {
    await pool.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'test','{}')", [simulationId]);
    const requestId = "3694afe8-39f4-4306-83de-1182edfd32a5";
    const reset = await post("/api/simulations", { requestId, startingCash: "5000" });
    expect(reset.statusCode).toBe(201);
    expect(reset.json().id).not.toBe(simulationId);
    expect((await pool.query("SELECT count(*)::int AS count FROM operational_events WHERE simulation_id=$1", [simulationId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT status FROM simulations WHERE id=$1", [simulationId])).rows[0].status).toBe("archived");
    expect((await post("/api/simulations", { requestId, startingCash: "1000" })).json().id).toBe(reset.json().id);
  });

  it("rejects foreign, null, and missing Origins before mutations", async () => {
    for (const origin of ["https://attacker.example", "null"]) {
      const headers = { ...requestHeaders, origin };
      expect((await post("/api/agent/pause", { reason: "manual" }, "POST", headers)).statusCode).toBe(403);
    }
    const noOrigin = Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => key !== "origin"));
    expect((await post("/api/agent/pause", { reason: "manual" }, "POST", noOrigin)).statusCode).toBe(403);
    expect((await post("/api/prompts", { name: "x", content: "y" }, "POST", { ...requestHeaders, host: "attacker.example" })).statusCode).toBe(403);
  });
});
