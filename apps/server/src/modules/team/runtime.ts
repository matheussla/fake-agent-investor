import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AgentTurnOutputSchema, type AgentTurnProvider, type DecisionInput, type DecisionProvider, type DecisionResult, type DecisionRecord, type TeamAgent } from "@paper-investor/contracts";
import { buildDecisionInput } from "../decisions/context.js";
import { reserveAttempt } from "../agent/usage.js";
import type { EventHub } from "../../http/sse.js";
import { listAgents } from "./roster.js";

type Run = { id: string; simulation_id: string; request_id: string; kind: "discussion" | "trading"; status: string; generation: number; configuration_version: number; target_agent_id: string | null; call_count: number; snapshot: { input: DecisionInput; agents: TeamAgent[] }; };
export class TeamRuntime implements DecisionProvider {
  readonly managesUsage = true;
  private controllers = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private pollTask?: Promise<void>;
  private tasks = new Set<Promise<DecisionResult>>();
  onIdle?: () => void;
  constructor(private readonly pool: Pool, private readonly provider: AgentTurnProvider, private readonly events: EventHub, private readonly limits = { calls: 20, runtimeMs: 180_000, turnMs: 60_000 }) {}

  start(): void {
    this.timer = setInterval(() => { if (!this.polling) this.pollTask = this.drain().catch(() => console.error("Team dispatcher failed")); }, 500);
    this.timer.unref();
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks, ...(this.pollTask ? [this.pollTask] : [])]);
    await this.pool.query("UPDATE team_runs SET status='interrupted',error='Server stopped',finished_at=now() WHERE status IN ('queued','working')");
    await this.pool.query("UPDATE agent_turns SET status='interrupted',error='Server stopped',finished_at=now() WHERE status IN ('queued','working')");
  }
  async recover(): Promise<void> {
    await this.pool.query("UPDATE chat_messages SET status='interrupted' WHERE status='queued'");
    await this.pool.query("UPDATE team_runs SET status='interrupted',error='Server restarted',finished_at=now() WHERE status IN ('queued','working')");
    await this.pool.query("UPDATE agent_turns SET status='interrupted',error='Server restarted',finished_at=now() WHERE status IN ('queued','working')");
  }
  async recordDecision(record: DecisionRecord): Promise<void> {
    await this.pool.query("UPDATE team_runs SET status=$2,error=$3,finished_at=now() WHERE decision_id=$1 AND status='working'", [record.id, record.status === "completed" ? "completed" : "failed", record.failure ?? null]);
    this.publish("team-run", record.simulationId);
  }
  async cancelSimulation(simulationId: string): Promise<void> {
    const runs = await this.pool.query("UPDATE team_runs SET status='cancelled',error='Work cancelled',finished_at=now() WHERE simulation_id=$1 AND status IN ('queued','working') RETURNING id", [simulationId]);
    for (const run of runs.rows) this.controllers.get(run.id)?.abort();
    await this.pool.query("UPDATE agent_turns SET status='cancelled',finished_at=now() WHERE run_id IN (SELECT id FROM team_runs WHERE simulation_id=$1 AND status='cancelled') AND status IN ('queued','working')", [simulationId]);
    await this.pool.query("UPDATE chat_messages SET status='cancelled' WHERE simulation_id=$1 AND status='queued'", [simulationId]);
    this.publish("team-run", simulationId);
  }
  async cancelRun(simulationId: string, runId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM simulations WHERE id=$1 AND status='active' FOR UPDATE", [simulationId]);
      const result = await client.query("UPDATE team_runs SET status='cancelled',error='Work cancelled',finished_at=now() WHERE id=$1 AND simulation_id=$2 AND status IN ('queued','working') RETURNING request_id,kind", [runId, simulationId]);
      if (result.rowCount) {
        await client.query("UPDATE agent_state SET generation=generation+1,cycle_running=false,claimed_request_id=NULL WHERE simulation_id=$1 AND claimed_request_id=$2", [simulationId, result.rows[0].request_id]);
        await client.query("UPDATE agent_turns SET status='cancelled',finished_at=now() WHERE run_id=$1 AND status IN ('queued','working')", [runId]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await this.pool.query("UPDATE chat_messages SET status='cancelled' WHERE run_id=$1 AND simulation_id=$2 AND status='queued' AND EXISTS(SELECT 1 FROM team_runs WHERE id=$1 AND status='cancelled')", [runId, simulationId]);
    this.controllers.get(runId)?.abort(); this.publish("team-run", simulationId);
  }

  async enqueue(simulationId: string, body: { requestId: string; targetAgentId?: string | null; content: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const simulation = await client.query("SELECT id FROM simulations WHERE id=$1 AND status='active' FOR UPDATE", [simulationId]);
      if (!simulation.rowCount) throw new Error("No active simulation");
      const prior = await client.query("SELECT id,target_agent_id FROM team_runs WHERE simulation_id=$1 AND request_id=$2", [simulationId, body.requestId]);
      if (prior.rowCount) {
        const message = (await client.query("SELECT * FROM chat_messages WHERE run_id=$1 AND kind='user' ORDER BY sequence LIMIT 1", [prior.rows[0].id])).rows[0];
        if (!message || message.content !== body.content || prior.rows[0].target_agent_id !== (body.targetAgentId ?? null)) throw new Error("Idempotency conflict");
        await client.query("COMMIT"); return { runId: prior.rows[0].id, message: messageDto(message) };
      }
      if (body.targetAgentId) {
        const target = await client.query("SELECT id FROM agents WHERE id=$1 AND simulation_id=$2 AND enabled AND NOT archived", [body.targetAgentId, simulationId]);
        if (!target.rowCount) throw new Error("Invalid target agent");
      }
      const result = await client.query("INSERT INTO team_runs(simulation_id,request_id,kind,status,target_agent_id,generation,configuration_version,snapshot) SELECT $1,$2,'discussion','queued',$3,generation,0,'{}' FROM agent_state WHERE simulation_id=$1 RETURNING id", [simulationId, body.requestId, body.targetAgentId ?? null]);
      const runId = result.rows[0].id as string;
      const message = await this.insertMessage(client, simulationId, runId, null, body.targetAgentId ?? null, "user", body.content, "queued");
      await client.query("COMMIT"); this.publish("chat-message", simulationId); this.publish("team-run", simulationId);
      return { runId, message: messageDto(message) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionResult> {
    const agents = (await listAgents(this.pool, input.simulationId)).filter((agent) => agent.enabled && !agent.archived);
    const client = await this.pool.connect();
    let run: Run;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM simulations WHERE id=$1 AND status='active' FOR UPDATE", [input.simulationId]);
      const state = (await client.query("SELECT * FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [input.simulationId])).rows[0];
      if (!state?.cycle_running || signal.aborted) throw new Error("Decision authorization expired");
      run = (await client.query("INSERT INTO team_runs(simulation_id,request_id,kind,status,decision_id,generation,configuration_version,snapshot,started_at) SELECT $1,$2,'trading','working',id,$3,$4,$5,now() FROM decisions WHERE simulation_id=$1 AND request_id=$2 RETURNING *", [input.simulationId, state.claimed_request_id, state.generation, input.configurationVersion, { input, agents }])).rows[0];
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const task = this.execute(run!, signal);
    this.tasks.add(task);
    try { return await task; } finally { this.tasks.delete(task); }
  }

  private async drain(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let worked = false;
    try {
      const client = await this.pool.connect();
      let run: Run | undefined;
      try {
        await client.query("BEGIN");
        const simulation = (await client.query("SELECT s.id FROM simulations s JOIN agent_state a ON a.simulation_id=s.id WHERE s.status='active' AND NOT a.cycle_running FOR UPDATE OF s SKIP LOCKED")).rows[0];
        if (simulation) {
          const state = (await client.query("SELECT * FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [simulation.id])).rows[0];
          if (!state.cycle_running) {
            run = (await client.query("SELECT * FROM team_runs WHERE simulation_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE", [simulation.id])).rows[0];
            if (run) {
              await client.query("UPDATE team_runs SET status='working',started_at=now(),generation=$2 WHERE id=$1", [run.id, state.generation]);
              await client.query("UPDATE agent_state SET cycle_running=true,claimed_request_id=$2 WHERE simulation_id=$1", [simulation.id, run.request_id]);
              run.generation = state.generation; run.status = "working";
            }
          }
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      if (run) {
        worked = true;
        try {
          const input = await buildDecisionInput(this.pool, run.simulation_id);
          const agents = (await listAgents(this.pool, run.simulation_id)).filter((agent) => agent.enabled && !agent.archived);
          run.snapshot = { input, agents }; run.configuration_version = input.configurationVersion;
          await this.pool.query("UPDATE team_runs SET snapshot=$2,configuration_version=$3 WHERE id=$1", [run.id, run.snapshot, run.configuration_version]);
          await this.execute(run, AbortSignal.timeout(this.limits.runtimeMs));
        } catch { await this.finish(run, "failed", "Discussion failed"); }
        finally {
          await this.pool.query("UPDATE agent_state SET cycle_running=false,claimed_request_id=NULL WHERE simulation_id=$1 AND claimed_request_id=$2", [run.simulation_id, run.request_id]);
        }
      }
    } finally { this.polling = false; if (worked) this.onIdle?.(); }
  }

  private async execute(run: Run, outerSignal: AbortSignal): Promise<DecisionResult> {
    const controller = new AbortController(); this.controllers.set(run.id, controller);
    const signal = AbortSignal.any([outerSignal, controller.signal, AbortSignal.timeout(this.limits.runtimeMs)]);
    const { agents } = run.snapshot;
    const lead = agents.find((agent) => agent.isLead);
    try {
      if (!lead) throw new Error("Enabled lead unavailable");
      const initial = run.kind === "trading" ? agents : [agents.find((agent) => agent.id === run.target_agent_id) ?? lead];
      const userMessage = (await this.pool.query("SELECT content FROM chat_messages WHERE run_id=$1 AND kind='user' ORDER BY sequence LIMIT 1", [run.id])).rows[0]?.content ?? "Analyze the supplied market and portfolio. Collaborate as needed and publish your findings.";
      await Promise.all(initial.map((agent) => this.pool.query("INSERT INTO agent_turns(run_id,agent_id,status,input) VALUES($1,$2,'queued',$3)", [run.id, agent.id, { messages: [userMessage] }])));
      this.publish("team-run", run.simulation_id);
      while (true) {
        signal.throwIfAborted();
        const queued = await this.pool.query("SELECT DISTINCT ON(agent_id) id,agent_id,input FROM agent_turns WHERE run_id=$1 AND status='queued' ORDER BY agent_id,created_at,id LIMIT 5", [run.id]);
        if (!queued.rowCount) break;
        const calls = (await this.pool.query("SELECT call_count FROM team_runs WHERE id=$1", [run.id])).rows[0].call_count;
        if (calls + queued.rows.length > this.limits.calls - (run.kind === "trading" ? 1 : 0)) throw new Error("Team call limit reached");
        let firstFailure: unknown;
        const outcomes = await Promise.allSettled(queued.rows.map(async (turn) => {
          try { return await this.runTurn(run, agents.find((agent) => agent.id === turn.agent_id)!, turn.id, turn.input.messages, false, signal); }
          catch (error) { firstFailure ??= error; controller.abort(); throw error; }
        }));
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure?.status === "rejected") throw firstFailure ?? failure.reason;
      }
      let result: DecisionResult = { decision: { action: "hold", explanation: "Discussion completed; trading was not authorized." } };
      if (run.kind === "trading") {
        const turn = (await this.pool.query("INSERT INTO agent_turns(run_id,agent_id,status,input) VALUES($1,$2,'queued',$3) RETURNING id", [run.id, lead.id, { messages: ["Produce the final trading decision from the team's findings."] }])).rows[0];
        const output = await this.runTurn(run, lead, turn.id, ["Produce the final trading decision from the team's findings."], true, signal);
        if (!output.decision) throw new Error("Lead decision unavailable");
        result = { decision: output.decision };
      }
      if (run.kind === "discussion") await this.finish(run, "completed");
      return result;
    } catch (error) {
      controller.abort();
      const message = error instanceof Error && ["Team call limit reached", "Daily provider allowance exhausted"].includes(error.message) ? error.message : outerSignal.aborted ? "Run cancelled or timed out" : "Agent response failed validation or provider unavailable";
      await this.finish(run, outerSignal.aborted ? "cancelled" : "failed", message);
      if (message === "Daily provider allowance exhausted") {
        await this.pool.query("UPDATE agent_state SET paused=true,pause_reason='usage_limit' WHERE simulation_id=$1", [run.simulation_id]);
        await this.cancelSimulation(run.simulation_id);
      }
      throw error;
    } finally { this.controllers.delete(run.id); }
  }

  private async runTurn(run: Run, agent: TeamAgent, turnId: string, messages: string[], finalize: boolean, signal: AbortSignal) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await this.authorize(client, run); signal.throwIfAborted();
      const claimed = await client.query("UPDATE team_runs SET call_count=call_count+1 WHERE id=$1 AND call_count<$2 RETURNING id", [run.id, this.limits.calls]);
      if (!claimed.rowCount) throw new Error("Team call limit reached");
      await reserveAttempt(client, (run.snapshot.input.limits as { provider: string }).provider, new Date(), Number((run.snapshot.input.limits as { dailyAttemptLimit?: number }).dailyAttemptLimit ?? 300));
      await client.query("UPDATE agent_turns SET status='working' WHERE id=$1 AND status='queued'", [turnId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    this.publish("team-run", run.simulation_id);
    const history = (await this.pool.query("SELECT sender_agent_id,recipient_agent_id,kind,left(content,2000) AS content FROM chat_messages WHERE simulation_id=$1 AND (recipient_agent_id IS NULL OR recipient_agent_id=$2 OR sender_agent_id=$2 OR run_id=$3) ORDER BY sequence DESC LIMIT 30", [run.simulation_id, agent.id, run.id])).rows.reverse();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.limits.turnMs)]);
    const output = AgentTurnOutputSchema.parse(await abortable(this.provider.turn({ agent, roster: run.snapshot.agents, context: run.snapshot.input, history, messages, finalize, kind: run.kind }, deadline), deadline));
    if ((!finalize && output.decision) || (finalize && (!agent.isLead || run.kind !== "trading" || output.handoffs.length || !output.decision))) throw new Error("Invalid decision authority");
    if (output.handoffs.some((handoff) => handoff.recipientAgentId === agent.id || !run.snapshot.agents.some((recipient) => recipient.id === handoff.recipientAgentId))) throw new Error("Invalid handoff recipient");
    const writer = await this.pool.connect();
    try {
      await writer.query("BEGIN"); await this.authorize(writer, run); deadline.throwIfAborted();
      await this.insertMessage(writer, run.simulation_id, run.id, agent.id, null, finalize ? "decision" : "message", finalize ? `${output.message}\n\n${JSON.stringify(output.decision)}` : output.message);
      for (const handoff of output.handoffs) {
        await this.insertMessage(writer, run.simulation_id, run.id, agent.id, handoff.recipientAgentId, "handoff", handoff.content);
        await writer.query("INSERT INTO agent_turns(run_id,agent_id,status,input) VALUES($1,$2,'queued',$3)", [run.id, handoff.recipientAgentId, { messages: [`${agent.name}: ${handoff.content}`] }]);
      }
      await writer.query("UPDATE agent_turns SET status='completed',output=$2,finished_at=now() WHERE id=$1", [turnId, output]);
      await writer.query("UPDATE chat_messages SET status='delivered' WHERE run_id=$1 AND kind='user'", [run.id]);
      await writer.query("COMMIT");
    } catch (error) { await writer.query("ROLLBACK"); throw error; } finally { writer.release(); }
    this.publish("chat-message", run.simulation_id); this.publish("team-run", run.simulation_id); return output;
  }
  private async authorize(client: PoolClient, run: Run): Promise<void> {
    const state = (await client.query("SELECT a.generation,a.claimed_request_id,s.status FROM simulations s JOIN agent_state a ON a.simulation_id=s.id WHERE s.id=$1 FOR UPDATE OF s,a", [run.simulation_id])).rows[0];
    const current = (await client.query("SELECT status FROM team_runs WHERE id=$1 FOR UPDATE", [run.id])).rows[0];
    if (state?.status !== "active" || state.generation !== run.generation || state.claimed_request_id !== run.request_id || current?.status !== "working") throw new Error("Decision authorization expired");
  }
  private async finish(run: Run, status: string, error: string | null = null): Promise<void> {
    await this.pool.query("UPDATE team_runs SET status=$2,error=$3,finished_at=now() WHERE id=$1 AND status='working'", [run.id, status, error]);
    if (status !== "completed") await this.pool.query("UPDATE agent_turns SET status=$2,error=$3,finished_at=now() WHERE run_id=$1 AND status IN ('queued','working')", [run.id, status, error]);
    await this.pool.query("UPDATE chat_messages SET status=$2 WHERE run_id=$1 AND status='queued'", [run.id, status === "completed" ? "delivered" : status]);
    this.publish("team-run", run.simulation_id);
  }
  private insertMessage(client: PoolClient, simulationId: string, runId: string, sender: string | null, recipient: string | null, kind: string, content: string, status = "delivered") {
    return client.query("INSERT INTO chat_messages(simulation_id,run_id,sender_agent_id,recipient_agent_id,kind,content,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [simulationId, runId, sender, recipient, kind, content, status]).then((result) => result.rows[0]);
  }
  private publish(type: string, simulationId: string): void { this.events.publish({ id: randomUUID(), type, occurredAt: new Date().toISOString(), simulationId, data: {} }); }
}

export function messageDto(row: Record<string, unknown>) {
  return { id: row.id, cursor: String(row.sequence), simulationId: row.simulation_id, runId: row.run_id, senderAgentId: row.sender_agent_id, recipientAgentId: row.recipient_agent_id, senderName: row.sender_name ?? (row.sender_agent_id ? "Agent" : "You"), recipientName: row.recipient_name ?? null, kind: row.kind, content: row.content, status: row.status, createdAt: row.created_at };
}
export function runDto(row: Record<string, unknown>) {
  return { id: row.id, simulationId: row.simulation_id, kind: row.kind, status: row.status, createdAt: row.created_at, completedAt: row.finished_at, error: row.error, decisionId: row.decision_id, callCount: row.call_count };
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener("abort", listener, { once: true }); })]); }
  finally { signal.removeEventListener("abort", listener); }
}
