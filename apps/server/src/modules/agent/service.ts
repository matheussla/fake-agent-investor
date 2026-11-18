import { randomUUID } from "node:crypto";
import type { Decision, DecisionInput, DecisionRecord, DecisionProvider, ExecutionProvider, ExecutionResult } from "@paper-investor/contracts";
import { DecisionSchema } from "@paper-investor/contracts";
import type { Pool, PoolClient } from "pg";
import { buildDecisionInput } from "../decisions/context.js";
import { refreshValuation } from "../portfolio/valuation.js";
import { enforceDailyLoss } from "../risk/daily-loss.js";
import { reserveAttempt } from "./usage.js";

export type PauseReason = "manual" | "daily_loss_limit" | "provider_failures" | "usage_limit" | "simulation_reset" | "shutdown";
export interface AgentState { simulationId: string; paused: boolean; generation: number; pauseReason: string | null; }
interface ClaimedCycle { simulationId: string; requestId: string; generation: number; configurationVersion: number; provider: string; manual: boolean; decisionId?: string; }
type ClaimResult = ClaimedCycle | { existing: DecisionRecord };
interface ServiceOptions { pool: Pool; providers: Record<string, DecisionProvider>; execution: ExecutionProvider; onDecision?: (record: DecisionRecord) => void | Promise<void>; now?: () => Date; decisionTimeoutMs?: number; managedUsage?: boolean; onPause?: (simulationId: string) => Promise<void>; }
type TradeDecision = Exclude<Decision, { action: "hold" }>;

export class AgentService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cycleTiming = new Map<string, { sessionStartedAt: string | null; sessionStoppedAt: string | null; nextCycleAt: string | null; cycleStartedAt: string | null; lastCycleEndedAt: string | null }>();
  private readonly now: () => Date;

  getCycleTiming(simulationId: string) {
    return this.cycleTiming.get(simulationId) ?? { sessionStartedAt: null, sessionStoppedAt: null, nextCycleAt: null, cycleStartedAt: null, lastCycleEndedAt: null };
  }

  constructor(private readonly options: ServiceOptions) { this.now = options.now ?? (() => new Date()); }

  async recoverOnStartup(): Promise<void> {
    await this.recordOpenSessionStops("server_restart");
    await this.options.pool.query("UPDATE decisions d SET failure='interrupted by server restart' FROM agent_state a WHERE d.simulation_id=a.simulation_id AND a.cycle_running=true AND d.request_id=a.claimed_request_id AND d.result IS NULL AND d.failure IS NULL");
    await this.options.pool.query("UPDATE agent_state SET paused=true,generation=generation+1,cycle_running=false,claimed_request_id=NULL,pause_reason='server_restart' WHERE cycle_running=true OR paused=false");
  }

  async startAgent(): Promise<AgentState> {
    const simulationId = await this.activeSimulationId();
    const [before] = (await this.options.pool.query("SELECT pause_reason FROM agent_state WHERE simulation_id=$1", [simulationId])).rows;
    if (before?.pause_reason === "daily_loss_limit") await this.ensureLossRecovered(simulationId);
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM simulations WHERE id=$1 AND status='active' FOR UPDATE", [simulationId]);
      const state = await client.query("SELECT paused,generation,cycle_running FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [simulationId]);
      if (!state.rowCount) throw new Error("Agent state unavailable");
      if (state.rows[0].cycle_running) throw new Error("Agent cycle is already running");
      await client.query("UPDATE agent_state SET paused=false,pause_reason=NULL WHERE simulation_id=$1", [simulationId]);
      if (state.rows[0].paused) await client.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'session_started',$2)", [simulationId, { generation: state.rows[0].generation, mode: "continuous" }]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    this.cycleTiming.set(simulationId, { ...this.getCycleTiming(simulationId), sessionStartedAt: this.now().toISOString(), sessionStoppedAt: null });
    this.scheduleNext(simulationId);
    return this.getAgentState(simulationId);
  }

  async pauseAgent(reason: PauseReason = "manual"): Promise<AgentState> {
    const simulationId = await this.activeSimulationId();
    // Interrupt local execution before waiting for the lock that its transaction holds.
    this.controllers.get(simulationId)?.abort(new DOMException("Agent paused", "AbortError"));
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM simulations WHERE id=$1 AND status='active' FOR UPDATE", [simulationId]);
      await client.query("UPDATE agent_state SET paused=true,generation=generation+1,cycle_running=false,claimed_request_id=NULL,pause_reason=$2 WHERE simulation_id=$1", [simulationId, reason]);
      await client.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'session_stopped',$2)", [simulationId, { reason }]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    this.controllers.get(simulationId)?.abort(new DOMException("Agent paused", "AbortError"));
    this.clearTimer(simulationId);
    this.cycleTiming.set(simulationId, { ...this.getCycleTiming(simulationId), sessionStoppedAt: this.now().toISOString() });
    await this.options.onPause?.(simulationId);
    return this.getAgentState(simulationId);
  }

  async runOnce(requestId: string): Promise<DecisionRecord> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("Invalid idempotency key");
    const prior = await this.options.pool.query("SELECT id,simulation_id,request_id,result,failure FROM decisions WHERE request_id=$1", [requestId]);
    if (prior.rowCount) return toDecisionRecord(prior.rows[0]);
    const claimed = await this.claimCycle(requestId, true);
    if ("existing" in claimed) return claimed.existing;
    return this.executeCycle(claimed);
  }

  async enqueueRunOnce(requestId: string): Promise<DecisionRecord> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("Invalid idempotency key");
    const prior = await this.options.pool.query("SELECT id,simulation_id,request_id,result,failure FROM decisions WHERE request_id=$1", [requestId]);
    if (prior.rowCount) return toDecisionRecord(prior.rows[0]);
    const claimed = await this.claimCycle(requestId, true);
    if ("existing" in claimed) return claimed.existing;
    void this.executeCycle(claimed).catch((error: unknown) => console.error("Run Once failed", safeFailure(error)));
    const row = await this.options.pool.query("SELECT id,simulation_id,request_id,result,failure FROM decisions WHERE id=$1", [claimed.decisionId]);
    return toDecisionRecord(row.rows[0]);
  }

  async close(): Promise<void> {
    await this.recordOpenSessionStops("shutdown");
    for (const simulationId of this.controllers.keys()) this.controllers.get(simulationId)?.abort(new DOMException("Server shutting down", "AbortError"));
    for (const simulationId of this.timers.keys()) this.clearTimer(simulationId);
    await this.options.pool.query("UPDATE agent_state SET paused=true,generation=generation+1,cycle_running=false,claimed_request_id=NULL,pause_reason='shutdown' WHERE paused=false OR cycle_running=true");
  }

  private async claimCycle(requestId: string, manual: boolean): Promise<ClaimResult> {
    const simulationId = await this.activeSimulationId();
    await enforceDailyLoss(this.options.pool, simulationId, this.options.now?.());
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM simulations WHERE id=$1 AND status='active' FOR UPDATE", [simulationId]);
      const prior = await client.query("SELECT id,simulation_id,request_id,result,failure FROM decisions WHERE simulation_id=$1 AND request_id=$2", [simulationId, requestId]);
      if (prior.rowCount) {
        await client.query("COMMIT");
        return { existing: toDecisionRecord(prior.rows[0]) };
      }
      const queuedChat = await client.query("SELECT id FROM team_runs WHERE simulation_id=$1 AND status='queued' LIMIT 1", [simulationId]);
      if (queuedChat.rowCount) throw new Error("Agent is paused or already processing a cycle");
      const state = await client.query("SELECT paused,generation,cycle_running,pause_reason FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [simulationId]);
      if (!state.rowCount || state.rows[0].cycle_running || state.rows[0].pause_reason === "daily_loss_limit" || (manual ? !state.rows[0].paused : state.rows[0].paused)) throw new Error(manual ? "Run Once requires an eligible paused agent" : "Agent is paused or already processing a cycle");
      const configuration = await client.query("SELECT version,values FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [simulationId]);
      const settings = configuration.rows[0]?.values as Record<string, unknown> | undefined;
      if (!configuration.rowCount || typeof settings?.provider !== "string") throw new Error("Agent configuration unavailable");
      const prompt = await client.query("SELECT p.version FROM prompts p JOIN agents a ON a.id=p.agent_id WHERE p.simulation_id=$1 AND p.active=true AND a.is_lead=true ORDER BY p.created_at DESC LIMIT 1", [simulationId]);
      if (!prompt.rowCount) throw new Error("Active prompt unavailable");
      await client.query("UPDATE agent_state SET cycle_running=true,claimed_request_id=$2 WHERE simulation_id=$1", [simulationId, requestId]);
      const decision = await client.query("INSERT INTO decisions(simulation_id,request_id,run_generation,configuration_version,prompt_version,input_snapshot) VALUES($1,$2,$3,$4,$5,'{\"status\":\"capturing\"}') RETURNING id", [simulationId, requestId, state.rows[0].generation, configuration.rows[0].version, prompt.rows[0].version]);
      await client.query("COMMIT");
      return { simulationId, requestId, generation: state.rows[0].generation, configurationVersion: configuration.rows[0].version, provider: settings.provider, manual, decisionId: decision.rows[0].id };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async executeCycle(claimed: ClaimedCycle): Promise<DecisionRecord> {
    const controller = new AbortController();
    this.controllers.set(claimed.simulationId, controller);
    this.cycleTiming.set(claimed.simulationId, { ...this.getCycleTiming(claimed.simulationId), nextCycleAt: null, cycleStartedAt: this.now().toISOString() });
    let decisionId: string | undefined = claimed.decisionId;
    let providerSucceeded = false;
    try {
      const provider = this.options.providers[claimed.provider];
      if (!provider) throw new Error("Configured provider unavailable");
      const input = await buildDecisionInput(this.options.pool, claimed.simulationId);
      if (input.configurationVersion !== claimed.configurationVersion) throw new Error("Configuration changed during decision capture");
      await this.validateClaim(claimed);
      const client = await this.options.pool.connect();
      try {
        await client.query("BEGIN");
        await this.validateClaimWithClient(client, claimed);
        if (!provider.managesUsage && (!this.options.managedUsage || claimed.provider !== "grok")) await reserveAttempt(client, claimed.provider, this.now(), Number((input.limits as { dailyAttemptLimit?: number }).dailyAttemptLimit ?? 300));
        decisionId = claimed.decisionId;
        await client.query("UPDATE decisions SET input_snapshot=$2,prompt_version=$3 WHERE id=$1", [decisionId, input, input.promptVersion]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.decisionTimeoutMs ?? 90_000)]);
      const result = await Promise.race([provider.decide(input, deadline), abortPromise(deadline)]);
      const decision = DecisionSchema.parse(result.decision);
      providerSucceeded = true;
      await this.validateClaim(claimed);
      const executionStarted = performance.now();
      const execution = decision.action !== "hold" ? await this.executeDecision(claimed, input, decision) : undefined;
      const executionMetrics = execution ? { ...execution, durationMs: Math.round(performance.now() - executionStarted), decisionAgeMs: input.capturedAt ? Date.now() - Date.parse(input.capturedAt) : null } : undefined;
      const saved = await this.options.pool.query("UPDATE decisions SET result=$2 WHERE id=$1 RETURNING id,simulation_id,request_id,result,failure", [decisionId, { decision, usage: result.usage ?? null, ...(executionMetrics ? { execution: executionMetrics } : {}) }]);
      await this.finishCycle(claimed, true);
      const record = toDecisionRecord(saved.rows[0]);
      await this.options.onDecision?.(record);
      return record;
    } catch (error) {
      let failure = controller.signal.aborted ? "Decision authorization expired" : safeFailure(error);
      try { await this.validateClaim(claimed); }
      catch { failure = "Decision authorization expired"; }
      if (decisionId) await this.options.pool.query("UPDATE decisions SET failure=$2 WHERE id=$1 AND result IS NULL", [decisionId, failure]);
      if (error instanceof Error && error.message === "Daily provider allowance exhausted") {
        await this.options.pool.query("UPDATE agent_state SET paused=true,generation=generation+1,cycle_running=false,claimed_request_id=NULL,pause_reason='usage_limit' WHERE simulation_id=$1 AND claimed_request_id=$2", [claimed.simulationId, claimed.requestId]);
        throw error;
      }
      await this.finishCycle(claimed, providerSucceeded, failure, controller.signal.aborted);
      if (!decisionId) throw error;
      const record = toDecisionRecord((await this.options.pool.query("SELECT id,simulation_id,request_id,result,failure FROM decisions WHERE id=$1", [decisionId])).rows[0]);
      await this.options.onDecision?.(record);
      return record;
    } finally {
      if (this.controllers.get(claimed.simulationId) === controller) this.controllers.delete(claimed.simulationId);
      this.cycleTiming.set(claimed.simulationId, { ...this.getCycleTiming(claimed.simulationId), cycleStartedAt: null, lastCycleEndedAt: this.now().toISOString() });
      if (!claimed.manual) this.scheduleNext(claimed.simulationId);
    }
  }

  private executeDecision(claimed: ClaimedCycle, input: DecisionInput, decision: TradeDecision): Promise<ExecutionResult> {
    const quote = input.market.find((candidate) => candidate.symbol === decision.symbol);
    if (!quote) throw new Error("Decision selected an unavailable quote");
    return this.options.execution.submit({ decisionId: claimed.decisionId as string, simulationId: claimed.simulationId, runGeneration: claimed.generation, configurationVersion: claimed.configurationVersion, symbol: decision.symbol, side: decision.action, quantity: decision.quantity, quote }, this.controllers.get(claimed.simulationId)?.signal ?? AbortSignal.timeout(5000));
  }

  private async finishCycle(claimed: ClaimedCycle, success: boolean, failure?: string, cancelled = false): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query("SELECT generation,claimed_request_id,consecutive_failures FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [claimed.simulationId]);
      if (state.rowCount && state.rows[0].generation === claimed.generation && state.rows[0].claimed_request_id === claimed.requestId) {
        const failures = cancelled ? state.rows[0].consecutive_failures : success ? 0 : state.rows[0].consecutive_failures + 1;
        const pause = !cancelled && failures >= 3;
        await client.query("UPDATE agent_state SET cycle_running=false,claimed_request_id=NULL,consecutive_failures=$2,paused=CASE WHEN $3 THEN true ELSE paused END,generation=CASE WHEN $3 THEN generation+1 ELSE generation END,pause_reason=CASE WHEN $3 THEN 'provider_failures' ELSE pause_reason END WHERE simulation_id=$1", [claimed.simulationId, failures, pause]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    if (failure) console.warn("Agent decision failed", { simulationId: claimed.simulationId, reason: failure });
  }

  private async validateClaim(claimed: ClaimedCycle): Promise<void> {
    const client = await this.options.pool.connect();
    try { await this.validateClaimWithClient(client, claimed); }
    finally { client.release(); }
  }

  private async validateClaimWithClient(client: PoolClient, claimed: ClaimedCycle): Promise<void> {
    const result = await client.query("SELECT s.status,a.paused,a.generation,a.cycle_running,a.claimed_request_id,c.version FROM simulations s JOIN agent_state a ON a.simulation_id=s.id JOIN LATERAL (SELECT version FROM configurations WHERE simulation_id=s.id ORDER BY version DESC LIMIT 1) c ON true WHERE s.id=$1", [claimed.simulationId]);
    const state = result.rows[0];
    if (state?.status !== "active" || state.generation !== claimed.generation || state.version !== claimed.configurationVersion || !state.cycle_running || state.claimed_request_id !== claimed.requestId || (!claimed.manual && state.paused)) throw new Error("Decision authorization expired");
  }

  private async ensureLossRecovered(simulationId: string): Promise<void> {
    const valuation = await refreshValuation(this.options.pool, simulationId, this.options.now?.());
    const result = await this.options.pool.query("SELECT b.equity::text AS baseline,c.values->>'dailyLossLimit' AS loss_limit FROM daily_baselines b JOIN LATERAL (SELECT values FROM configurations WHERE simulation_id=b.simulation_id ORDER BY version DESC LIMIT 1) c ON true WHERE b.simulation_id=$1 AND b.utc_date=$2", [simulationId, this.now().toISOString().slice(0, 10)]);
    const state = result.rows[0];
    if (!state || !state.baseline || !state.loss_limit || Number(valuation.equity) <= Number(state.baseline) * (1 - Number(state.loss_limit))) throw new Error("Daily loss pause is not eligible to resume");
  }

  private async activeSimulationId(): Promise<string> {
    const active = await this.options.pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
    if (!active.rowCount) throw new Error("No active simulation");
    return active.rows[0].id as string;
  }

  private async getAgentState(simulationId: string): Promise<AgentState> {
    const result = await this.options.pool.query("SELECT simulation_id,paused,generation,pause_reason FROM agent_state WHERE simulation_id=$1", [simulationId]);
    if (!result.rowCount) throw new Error("Agent state unavailable");
    return { simulationId: result.rows[0].simulation_id, paused: result.rows[0].paused, generation: result.rows[0].generation, pauseReason: result.rows[0].pause_reason };
  }

  scheduleAfterDiscussion(): void {
    void this.activeSimulationId().then((id) => this.scheduleNext(id)).catch(() => console.warn("Unable to reschedule team"));
  }

  private scheduleNext(simulationId: string, delay = 0): void {
    this.clearTimer(simulationId);
    const timer = setTimeout(() => {
      this.clearTimer(simulationId);
      void this.scheduleEvaluation(simulationId).catch((error: unknown) => {
        if (!(error instanceof Error) || !/Agent is paused or already processing/.test(error.message)) console.warn("Agent scheduler skipped evaluation", safeFailure(error));
        this.scheduleNext(simulationId, 1000);
      });
    }, delay);
    this.timers.set(simulationId, timer);
  }

  private async scheduleEvaluation(simulationId: string): Promise<void> {
    const { rows } = await this.options.pool.query("SELECT a.paused,a.pause_reason,a.cycle_running,c.values->>'dailyAttemptLimit' AS budget,COALESCE(u.attempts,0) AS attempts FROM agent_state a JOIN LATERAL (SELECT values FROM configurations WHERE simulation_id=a.simulation_id ORDER BY version DESC LIMIT 1) c ON true LEFT JOIN daily_usage u ON u.provider='all' AND u.utc_date=$2 WHERE a.simulation_id=$1", [simulationId, this.now().toISOString().slice(0, 10)]);
    if (!rows[0] || rows[0].paused) {
      const timing = this.getCycleTiming(simulationId);
      if (timing.sessionStartedAt && !timing.sessionStoppedAt) {
        await this.recordOpenSessionStops(rows[0]?.pause_reason ?? "automatic_pause", simulationId);
        this.cycleTiming.set(simulationId, { ...timing, sessionStoppedAt: this.now().toISOString() });
      }
      return;
    }
    if (rows[0].cycle_running) return;
    if (Number(rows[0].attempts) >= Math.ceil(Number(rows[0].budget ?? 300) * 0.95)) {
      await this.pauseAgent("usage_limit");
      return;
    }
    const claim = await this.claimCycle(randomUUID(), false);
    if (!("existing" in claim)) await this.executeCycle(claim);
  }

  private async recordOpenSessionStops(reason: string, simulationId?: string): Promise<void> {
    await this.options.pool.query("INSERT INTO operational_events(simulation_id,kind,payload) SELECT e.simulation_id,'session_stopped',jsonb_build_object('reason',$1::text,'sessionId',e.id) FROM operational_events e WHERE e.kind='session_started' AND ($2::uuid IS NULL OR e.simulation_id=$2) AND NOT EXISTS(SELECT 1 FROM operational_events later WHERE later.simulation_id=e.simulation_id AND later.kind IN ('session_started','session_stopped') AND later.created_at>e.created_at)", [reason, simulationId ?? null]);
  }

  private clearTimer(simulationId: string): void {
    const timer = this.timers.get(simulationId);
    if (timer) clearTimeout(timer);
    this.timers.delete(simulationId);
    this.cycleTiming.set(simulationId, { ...this.getCycleTiming(simulationId), nextCycleAt: null });
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new DOMException("Decision aborted", "AbortError"));
    else signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Decision aborted", "AbortError")), { once: true });
  });
}

function safeFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error && error.message.startsWith("Risk rejected order: ")) return error.message;
  if (error instanceof Error && ["Decision authorization expired", "Daily loss pause is latched", "Daily loss limit reached; pause latched"].includes(error.message)) return error.message;
  return "Provider or execution failure";
}

function toDecisionRecord(row: { id: string; simulation_id: string; request_id: string; result?: { decision?: Decision }; failure?: string | null }): DecisionRecord {
  return { id: row.id, simulationId: row.simulation_id, requestId: row.request_id, status: row.failure ? "failed" : row.result ? "completed" : "pending", result: row.result?.decision, failure: row.failure ?? undefined };
}
