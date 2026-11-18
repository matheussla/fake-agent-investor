import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnInput, AgentTurnOutput, AgentTurnProvider, ExecutionProvider } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation, resetSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { TeamRuntime } from "../../apps/server/src/modules/team/runtime.js";
import { AgentService } from "../../apps/server/src/modules/agent/service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { EventHub } from "../../apps/server/src/http/sse.js";

const { pool, db } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;
let team: TeamRuntime;
let agent: AgentService;
const output = (input: AgentTurnInput): AgentTurnOutput => ({ message: `${input.agent.name} findings`, handoffs: [], decision: input.finalize ? { action: "hold", explanation: "No supported trade." } : null });
function setup(provider: AgentTurnProvider, calls = 20, turnMs = 1000) {
  team = new TeamRuntime(pool, provider, new EventHub(), { calls, turnMs, runtimeMs: 5000 });
  const execution = { submit: vi.fn() } as unknown as ExecutionProvider;
  agent = new AgentService({ pool, providers: { grok: team, codex: team }, execution, managedUsage: true, onDecision: (record) => team.recordDecision(record), onPause: (id) => team.cancelSimulation(id) });
  return execution;
}
beforeEach(async () => { await pool.query("TRUNCATE simulations CASCADE"); await pool.query("TRUNCATE daily_usage"); simulationId = (await createSimulation(db)).id; });
afterEach(async () => { await team?.close(); await agent?.close(); });
afterAll(async () => pool.end());

describe("team harness", () => {
  it("runs five distinct prompts concurrently, delivers a handoff, and finalizes only with the lead", async () => {
    const seen: AgentTurnInput[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    setup({ turn: async (input) => {
      seen.push(input);
      if (seen.length <= 5) await barrier;
      const result = output(input);
      if (input.agent.name === "Market Analyst" && !input.messages[0].includes(":")) result.handoffs.push({recipientAgentId:input.roster.find((a)=>a.name === "Risk Analyst")!.id,content:"Review concentration risk."});
      return result;
    } });
    const run = agent.runOnce(crypto.randomUUID());
    await vi.waitFor(() => expect(seen).toHaveLength(5));
    expect(new Set(seen.map((item)=>item.agent.prompt)).size).toBe(5);
    release();
    expect(await run).toMatchObject({status:"completed",result:{action:"hold"}});
    expect(seen).toHaveLength(7);
    expect(seen.at(-1)).toMatchObject({finalize:true,agent:{isLead:true}});
    expect(seen.some((item)=>item.messages.some((message)=>message.includes("Review concentration risk.")))).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM chat_messages WHERE kind='handoff'")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(7);
  });

  it("deduplicates chat requests and never gives discussion a trading finalization", async () => {
    const seen: AgentTurnInput[] = [];
    const execution = setup({turn:async(input)=>{seen.push(input);return output(input);}});
    const body = {requestId:crypto.randomUUID(),content:"Explain current risk."};
    const first = await team.enqueue(simulationId,body);
    expect((await team.enqueue(simulationId,body)).runId).toBe(first.runId);
    await expect(team.enqueue(simulationId,{...body,content:"Different request"})).rejects.toThrow("Idempotency conflict");
    team.start();
    await vi.waitFor(async()=>expect((await pool.query("SELECT status FROM team_runs WHERE id=$1",[first.runId])).rows[0].status).toBe("completed"),{timeout:3000});
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({kind:"discussion",finalize:false});
    expect(execution.submit).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS count FROM decisions")).rows[0].count).toBe(0);
  });

  it("rejects foreign recipients and specialist trading decisions", async () => {
    setup({turn:async(input)=>({...output(input),decision:{action:"hold",explanation:"Unauthorized"}})});
    await expect(team.enqueue(simulationId,{requestId:crypto.randomUUID(),targetAgentId:crypto.randomUUID(),content:"Hello"})).rejects.toThrow("Invalid target");
    expect(await agent.runOnce(crypto.randomUUID())).toMatchObject({status:"failed"});
    expect((await pool.query("SELECT count(*)::int AS count FROM orders")).rows[0].count).toBe(0);
  });

  it("bounds message loops and leaves no runnable turns", async () => {
    setup({turn:async(input)=>({...output(input),handoffs:[{recipientAgentId:input.roster.find((a)=>a.id!==input.agent.id)!.id,content:"More analysis"}]})},6);
    expect(await agent.runOnce(crypto.randomUUID())).toMatchObject({status:"failed"});
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_turns WHERE status IN ('queued','working')")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT call_count FROM team_runs")).rows[0].call_count).toBe(5);
  });

  it("pause aborts all five turns and prevents late message publication", async () => {
    const signals: AbortSignal[] = [];
    setup({turn:(input,signal)=>{signals.push(signal); return new Promise((resolve)=>signal.addEventListener("abort",()=>resolve(output(input)),{once:true}));}});
    const pending = agent.runOnce(crypto.randomUUID());
    await vi.waitFor(()=>expect(signals).toHaveLength(5));
    await agent.pauseAgent();
    expect(await pending).toMatchObject({status:"failed"});
    expect(signals.every((signal)=>signal.aborted)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM chat_messages")).rows[0].count).toBe(0);
  });

  it("enforces a shared daily cap across parallel turns", async () => {
    await pool.query("UPDATE configurations SET values=jsonb_set(values,'{dailyAttemptLimit}','2') WHERE simulation_id=$1",[simulationId]);
    setup({turn:async(input)=>output(input)});
    await expect(agent.runOnce(crypto.randomUUID())).rejects.toThrow("Daily provider allowance exhausted");
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(2);
    expect((await pool.query("SELECT paused,pause_reason FROM agent_state WHERE simulation_id=$1",[simulationId])).rows[0]).toMatchObject({paused:true,pause_reason:"usage_limit"});
  });

  it("interrupts queued work on restart and rejects stale output after reset", async () => {
    let release!: ()=>void;
    const barrier = new Promise<void>((resolve)=>{release=resolve;});
    setup({turn:async(input)=>{await barrier;return output(input);}});
    const pending = agent.runOnce(crypto.randomUUID());
    await vi.waitFor(async()=>expect((await pool.query("SELECT count(*)::int AS count FROM agent_turns WHERE status='working'")).rows[0].count).toBe(5));
    await resetSimulation(db,{requestId:crypto.randomUUID(),startingCash:"1000"}); release();
    expect(await pending).toMatchObject({status:"failed"});
    const active = (await pool.query("SELECT id FROM simulations WHERE status='active'")).rows[0].id;
    const queued = await team.enqueue(active,{requestId:crypto.randomUUID(),content:"Queued question"});
    await team.recover();
    expect((await pool.query("SELECT status FROM team_runs WHERE id=$1",[queued.runId])).rows[0].status).toBe("interrupted");
  });
  it("validates local API requests and pages chat history without losing messages", async () => {
    setup({turn:async(input)=>output(input)});
    const app = buildApp(pool,new EventHub(),{db,agent,team});
    const headers = {host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000","content-type":"application/json"};
    try {
      expect((await app.inject({method:"POST",url:"/api/chat/messages",headers,payload:{content:"Missing ID"}})).statusCode).toBe(400);
      expect((await app.inject({method:"POST",url:"/api/chat/messages",headers:{...headers,origin:"https://evil.example"},payload:{requestId:crypto.randomUUID(),content:"No"}})).statusCode).toBe(403);
      const roster = (await app.inject({method:"GET",url:"/api/agents",headers})).json();
      expect(roster).toHaveLength(5);
      const first = (await app.inject({method:"POST",url:"/api/chat/messages",headers,payload:{requestId:crypto.randomUUID(),content:"First",targetAgentId:roster[0].id}})).json();
      await app.inject({method:"POST",url:"/api/chat/messages",headers,payload:{requestId:crypto.randomUUID(),content:"Second"}});
      const page = (await app.inject({method:"GET",url:`/api/chat/messages?after=${first.message.cursor}`,headers})).json();
      expect(page.messages.map((message:{content:string})=>message.content)).toEqual(["Second"]);
      const single = (await app.inject({method:"GET",url:`/api/chat/messages?agentId=${roster[0].id}`,headers})).json();
      expect(single.messages).toHaveLength(1);
      expect((await app.inject({method:"PATCH",url:`/api/agents/${roster[0].id}`,headers,payload:{name:"Busy edit"}})).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it("times out a hung provider without leaving runnable work", async () => {
    setup({turn:()=>new Promise(()=>{})},20,20);
    expect(await agent.runOnce(crypto.randomUUID())).toMatchObject({status:"failed"});
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_turns WHERE status IN ('queued','working')")).rows[0].count).toBe(0);
  });

});

it("attributes OpenAI team calls exactly once to codex", async () => {
  await pool.query("UPDATE configurations SET values=values || '{\"provider\":\"codex\",\"model\":\"gpt-5.3-codex\"}'::jsonb WHERE simulation_id=$1", [simulationId]);
  setup({ turn: async (input) => output(input) });
  expect(await agent.runOnce(crypto.randomUUID())).toMatchObject({ status: "completed" });
  const usage = (await pool.query("SELECT provider,attempts FROM daily_usage ORDER BY provider")).rows;
  expect(usage).toEqual([{ provider: "all", attempts: 6 }, { provider: "codex", attempts: 6 }]);
});
