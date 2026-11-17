import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionInput, DecisionProvider, ExecutionProvider } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { AgentService } from "../../apps/server/src/modules/agent/service.js";
import { reserveAttempt } from "../../apps/server/src/modules/agent/usage.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;
let agents: AgentService[] = [];

beforeEach(async () => {
  await pool.query("TRUNCATE simulations CASCADE");
  await pool.query("TRUNCATE daily_usage");
  simulationId = (await createSimulation(db)).id;
});
afterEach(async () => { await Promise.all(agents.map((agent) => agent.close())); agents = []; });
afterAll(async () => pool.end());

function service(provider: DecisionProvider, decisionTimeoutMs = 90_000) {
  const execution = { submit: vi.fn(async () => ({ status: "filled" as const, orderId: crypto.randomUUID() })) } as unknown as ExecutionProvider;
  const agent = new AgentService({ pool, providers: { grok: provider }, execution, decisionTimeoutMs });
  agents.push(agent);
  return { agent, execution };
}
const holdProvider = (): DecisionProvider => ({ decide: vi.fn(async (input: DecisionInput) => { void input; return { decision: { action: "hold", explanation: "Wait for better evidence." } }; }) });

describe("persistent agent lifecycle", () => {
  it("runs once while paused, records exact versions, and deduplicates request IDs", async () => {
    const provider = holdProvider();
    const { agent } = service(provider);
    const requestId = "c87e33d6-d88e-4791-9c79-0de6c4a8dbda";
    const result = await agent.runOnce(requestId);
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({ action: "hold" });
    expect(await agent.runOnce(requestId)).toEqual(result);
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT paused,cycle_running FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toEqual({ paused: true, cycle_running: false });
    expect((await pool.query("SELECT configuration_version,prompt_version FROM decisions WHERE request_id=$1", [requestId])).rows[0]).toEqual({ configuration_version: 1, prompt_version: 1 });
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(1);
  });

  it("lets only one concurrent Run Once claim proceed", async () => {
    let release!: (value: { decision: { action: "hold"; explanation: string } }) => void;
    const provider: DecisionProvider = { decide: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const { agent } = service(provider);
    const requestId = "178dc785-9907-4584-8b3a-554952e0f1b9";
    const first = agent.runOnce(requestId);
    await vi.waitFor(async () => expect((await pool.query("SELECT cycle_running FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0].cycle_running).toBe(true));
    expect(await agent.runOnce(requestId)).toMatchObject({ status: "pending", requestId });
    release({ decision: { action: "hold", explanation: "No trade." } });
    expect((await first).status).toBe("completed");
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it("starts on the configured five-minute cadence and pauses explicitly", async () => {
    const { agent } = service(holdProvider());
    const timer = vi.spyOn(globalThis, "setTimeout");
    const started = await agent.startAgent();
    expect(started.paused).toBe(false);
    await vi.waitFor(() => expect(timer.mock.calls.some(([, delay]) => delay === 300_000)).toBe(true));
    expect(await agent.pauseAgent("manual")).toMatchObject({ paused: true, pauseReason: "manual" });
    timer.mockRestore();
  });

  it("aborts and invalidates a pending decision when paused", async () => {
    let providerSignal!: AbortSignal;
    let release!: (value: { decision: { action: "hold"; explanation: string } }) => void;
    const provider: DecisionProvider = { decide: vi.fn((input, signal) => { void input; providerSignal = signal; return new Promise((resolve) => { release = resolve; }); }) };
    const { agent, execution } = service(provider);
    const pending = agent.runOnce("604e48bf-8dc8-49ba-9f37-c62de41f25fa");
    await vi.waitFor(() => expect(provider.decide).toHaveBeenCalledTimes(1));
    await agent.pauseAgent("manual");
    expect(providerSignal.aborted).toBe(true);
    release({ decision: { action: "hold", explanation: "Late response." } });
    expect(await pending).toMatchObject({ status: "failed", failure: "Decision authorization expired" });
    expect(execution.submit).not.toHaveBeenCalled();
  });

  it("counts a dispatched timeout and pauses after three provider failures", async () => {
    const provider: DecisionProvider = { decide: vi.fn(async () => { throw new Error("private provider response body"); }) };
    const { agent } = service(provider);
    for (const requestId of ["d274d16b-0994-4268-95ab-dd1f34fa7c7a", "0a17c8b8-9392-42b4-b263-302c72c4ae4d", "c6370243-9efb-4985-a878-2a9d6926eebc"]) await agent.runOnce(requestId);
    expect((await pool.query("SELECT paused,pause_reason,consecutive_failures FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, pause_reason: "provider_failures", consecutive_failures: 3 });
    expect((await pool.query("SELECT count(*)::int AS count FROM daily_usage WHERE provider='all'")).rows[0].count).toBe(1);
  });

  it("aborts a provider request at the configured decision deadline", async () => {
    const provider: DecisionProvider = { decide: vi.fn((input, signal) => { void input; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }) };
    const { agent } = service(provider, 20);
    const result = await agent.runOnce("295521f7-3d78-4ce5-96fa-a850324f1878");
    expect(result).toMatchObject({ status: "failed", failure: "Provider or execution failure" });
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(1);
  });

  it("enforces the application-wide 300 attempt cap and UTC date rollovers", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < 300; index += 1) await reserveAttempt(client, index % 2 ? "grok" : "codex", new Date("2026-11-16T23:59:59Z"));
      await expect(reserveAttempt(client, "grok", new Date("2026-11-16T23:59:59Z"))).rejects.toThrow("allowance exhausted");
      await reserveAttempt(client, "grok", new Date("2026-11-17T00:00:00Z"));
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const usage = await pool.query("SELECT utc_date,provider,attempts FROM daily_usage ORDER BY utc_date,provider");
    expect(usage.rows.find((row) => row.utc_date === "2026-11-16" && row.provider === "all").attempts).toBe(300);
    expect(usage.rows.find((row) => row.utc_date === "2026-11-17" && row.provider === "all").attempts).toBe(1);
  });

  it("invalidates interrupted cycles on restart and starts paused", async () => {
    const provider = holdProvider();
    const { agent } = service(provider);
    const requestId = "49d8c2b5-6381-44e5-8c24-926fef978cb4";
    await pool.query("INSERT INTO decisions(simulation_id,request_id,run_generation,configuration_version,prompt_version,input_snapshot) VALUES($1,$2,0,1,1,'{}')", [simulationId, requestId]);
    await pool.query("UPDATE agent_state SET paused=false,cycle_running=true,claimed_request_id=$2 WHERE simulation_id=$1", [simulationId, requestId]);
    await agent.recoverOnStartup();
    expect((await pool.query("SELECT paused,generation,cycle_running,pause_reason FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, generation: 1, cycle_running: false, pause_reason: "server_restart" });
    expect((await pool.query("SELECT failure FROM decisions WHERE request_id=$1", [requestId])).rows[0].failure).toBe("interrupted by server restart");
  });
});
