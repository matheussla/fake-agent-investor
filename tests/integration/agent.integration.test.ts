import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionInput, DecisionProvider, ExecutionProvider } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { AgentService } from "../../apps/server/src/modules/agent/service.js";
import { reserveAttempt } from "../../apps/server/src/modules/agent/usage.js";
import { createSimulation, resetSimulation } from "../../apps/server/src/modules/simulations/service.js";

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
  it("counts Codex requests and enforces the allowance alongside managed team usage", async () => {
    await pool.query("UPDATE configurations SET values=values || $1::jsonb WHERE simulation_id=$2", [JSON.stringify({ provider: "codex", model: "gpt-5.3-codex", dailyAttemptLimit: 1 }), simulationId]);
    const provider = holdProvider();
    const execution = { submit: vi.fn() } as unknown as ExecutionProvider;
    const agent = new AgentService({ pool, providers: { codex: provider }, execution, managedUsage: true });
    agents.push(agent);
    expect(await agent.runOnce(crypto.randomUUID())).toMatchObject({ status: "completed" });
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='codex'")).rows[0]?.attempts).toBe(1);
    await expect(agent.runOnce(crypto.randomUUID())).rejects.toThrow("Daily provider allowance exhausted");
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT paused,pause_reason FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, pause_reason: "usage_limit" });
    expect(execution.submit).not.toHaveBeenCalled();
  });

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
    await vi.waitFor(() => expect(provider.decide).toHaveBeenCalledTimes(1));
    release({ decision: { action: "hold", explanation: "No trade." } });
    expect((await first).status).toBe("completed");
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it("serializes claims across server instances and rejects a late result after reset", async () => {
    let release!: (value: { decision: { action: "hold"; explanation: string } }) => void;
    const provider: DecisionProvider = { decide: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const first = service(provider);
    const second = service(provider);
    const pending = first.agent.runOnce("388ae885-6445-4fd8-9167-e79de15d1e33");
    await vi.waitFor(() => expect(provider.decide).toHaveBeenCalledTimes(1));

    await expect(second.agent.runOnce("fd5e5df1-5eb3-4f50-afac-fab81729926d")).rejects.toThrow(/eligible paused agent|already processing/);
    await resetSimulation(db, { requestId: "3564c60b-731c-4739-9d0a-cf55c175cd1a", startingCash: "2500" });
    release({ decision: { action: "hold", explanation: "Late response." } });

    expect(await pending).toMatchObject({ status: "failed", failure: "Decision authorization expired" });
    expect(first.execution.submit).not.toHaveBeenCalled();
    expect(second.execution.submit).not.toHaveBeenCalled();
  });

  it("evaluates continuously without overlap and stops on pause", async () => {
    const provider = holdProvider();
    const { agent } = service(provider);
    await agent.startAgent();
    await vi.waitFor(() => expect(vi.mocked(provider.decide).mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(agent.getCycleTiming(simulationId).sessionStartedAt).toBeTruthy();
    await agent.pauseAgent();
    const count = vi.mocked(provider.decide).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.decide).toHaveBeenCalledTimes(count);
    expect(agent.getCycleTiming(simulationId).sessionStoppedAt).toBeTruthy();
  });

  it("stops before making another call at 95 percent of the budget", async () => {
    const { agent } = service(holdProvider());
    await pool.query("UPDATE configurations SET values=values || '{\"dailyAttemptLimit\":20}'::jsonb WHERE simulation_id=$1", [simulationId]);
    await pool.query("INSERT INTO daily_usage(utc_date,provider,attempts) VALUES(CURRENT_DATE,'all',19)");
    await agent.startAgent();
    await vi.waitFor(async () => expect((await pool.query("SELECT paused,pause_reason FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, pause_reason: "usage_limit" }));
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(19);
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
    expect((await pool.query("SELECT consecutive_failures FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0].consecutive_failures).toBe(0);
  });

  it("counts a dispatched timeout and pauses after three provider failures", async () => {
    const provider: DecisionProvider = { decide: vi.fn(async () => { throw new Error("private provider response body"); }) };
    const { agent } = service(provider);
    for (const requestId of ["d274d16b-0994-4268-95ab-dd1f34fa7c7a", "0a17c8b8-9392-42b4-b263-302c72c4ae4d", "c6370243-9efb-4985-a878-2a9d6926eebc"]) await agent.runOnce(requestId);
    expect((await pool.query("SELECT paused,pause_reason,consecutive_failures FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, pause_reason: "provider_failures", consecutive_failures: 3 });
    expect((await pool.query("SELECT count(*)::int AS count FROM daily_usage WHERE provider='all'")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT string_agg(coalesce(failure,''), ' ') AS failures FROM decisions")).rows[0].failures).not.toContain("private provider response body");
  });

  it("aborts a provider request at the configured decision deadline", async () => {
    const provider: DecisionProvider = { decide: vi.fn((input, signal) => { void input; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }) };
    const { agent } = service(provider, 20);
    const result = await agent.runOnce("295521f7-3d78-4ce5-96fa-a850324f1878");
    expect(result).toMatchObject({ status: "failed", failure: "Provider or execution failure" });
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(1);
  });

  it("enforces the application-wide 95 percent cutoff and UTC date rollovers", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let index = 0; index < 285; index += 1) await reserveAttempt(client, index % 2 ? "grok" : "codex", new Date("2026-11-16T23:59:59Z"));
      await expect(reserveAttempt(client, "grok", new Date("2026-11-16T23:59:59Z"))).rejects.toThrow("allowance exhausted");
      await reserveAttempt(client, "grok", new Date("2026-11-17T00:00:00Z"));
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const usage = await pool.query("SELECT utc_date,provider,attempts FROM daily_usage ORDER BY utc_date,provider");
    expect(usage.rows.find((row) => row.utc_date === "2026-11-16" && row.provider === "all").attempts).toBe(285);
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

it("runs buy and sell through the real executor and replays accepted requests without another fill", async () => {
  const { PaperExecutionProvider } = await import("../../apps/server/src/modules/execution/paper.js");
  const now = new Date();
  await pool.query("TRUNCATE quote_samples");
  await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,100.1,3,3,$1,$1)", [now]);
  const market = { instruments: async () => [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "trading", priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" }] } as unknown as import("../../packages/contracts/src/domain.js").MarketDataProvider;
  let side: "buy" | "sell" = "buy";
  const provider: DecisionProvider = { decide: async () => ({ decision: { action: side, symbol: "BTCUSDT", quantity: "0.5", explanation: "Deterministic integration trade." } }) };
  const agent = new AgentService({ pool, providers: { grok: provider }, execution: new PaperExecutionProvider(pool, market) });
  agents.push(agent);
  const requestId = crypto.randomUUID();
  const bought = await agent.runOnce(requestId);
  expect(bought.status).toBe("completed");
  expect(await agent.enqueueRunOnce(requestId)).toEqual(bought);
  side = "sell";
  const sold = await agent.runOnce(crypto.randomUUID());
  expect(sold.status).toBe("completed");
  expect((await pool.query("SELECT count(*)::int AS count FROM fills WHERE simulation_id=$1", [simulationId])).rows[0].count).toBe(2);
  expect((await pool.query("SELECT quantity::text FROM positions WHERE simulation_id=$1", [simulationId])).rows[0].quantity).toBe("0.000000000000000000");
  const evidence = (await pool.query("SELECT result FROM decisions WHERE id=$1", [sold.id])).rows[0].result;
  expect(evidence.execution).toMatchObject({ status: "filled", durationMs: expect.any(Number), decisionAgeMs: expect.any(Number) });
});

it("returns an accepted Run Once result even when current holdings cannot be valued", async () => {
  const { agent } = service(holdProvider());
  const requestId = crypto.randomUUID();
  const result = await agent.runOnce(requestId);
  await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'MISSINGUSDT',1,1)", [simulationId]);
  expect(await agent.enqueueRunOnce(requestId)).toEqual(result);
});

it("uses fresh time when Run Once waits behind a trade before reading quotes", async () => {
  const { agent } = service(holdProvider());
  await pool.query("TRUNCATE quote_samples");
  await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'BTCUSDT',1,100)", [simulationId]);
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM simulations WHERE id=$1 FOR UPDATE", [simulationId]);
  const pending = agent.runOnce(crypto.randomUUID());
  const outcome = expect(pending).resolves.toMatchObject({ status: "completed" });
  try {
    await vi.waitFor(async () => expect((await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].count).toBeGreaterThan(0));
    await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,101,1,1,clock_timestamp(),clock_timestamp())");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  await outcome;
});

it("Pause cancels a local fill before waiting for its portfolio lock", async () => {
  const { PaperExecutionProvider } = await import("../../apps/server/src/modules/execution/paper.js");
  await pool.query("TRUNCATE quote_samples");
  await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,100.1,3,3,now(),now())");
  let executionSignal!: AbortSignal;
  const market = { instruments: async (signal: AbortSignal) => { executionSignal = signal; return [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "trading", priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" }]; } } as unknown as import("../../packages/contracts/src/domain.js").MarketDataProvider;
  let written!: () => void;
  const ledgerWritten = new Promise<void>((resolve) => { written = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executionPool = { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      if (sql.startsWith("INSERT INTO ledger_entries")) { written(); await gate; }
      return result;
    } };
  } } as unknown as typeof pool;
  const provider: DecisionProvider = { decide: async () => ({ decision: { action: "buy", symbol: "BTCUSDT", quantity: "0.5", explanation: "Cancellation test." } }) };
  const agent = new AgentService({ pool, providers: { grok: provider }, execution: new PaperExecutionProvider(executionPool, market) });
  agents.push(agent);
  const running = agent.runOnce(crypto.randomUUID());
  await ledgerWritten;
  const paused = agent.pauseAgent();
  try { await vi.waitFor(() => expect(executionSignal.aborted).toBe(true), { timeout: 500 }); }
  finally { release(); await Promise.allSettled([running, paused]); }
  expect((await pool.query("SELECT count(*)::int AS count FROM fills WHERE simulation_id=$1", [simulationId])).rows[0].count).toBe(0);
  expect((await pool.query("SELECT sum(amount)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [simulationId])).rows[0].cash).toBe("10000.000000000000000000");
});
