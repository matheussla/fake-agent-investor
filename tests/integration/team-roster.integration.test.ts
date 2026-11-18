import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation, resetSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { activateAgentPrompt, createAgent, listAgents, listAgentPrompts, saveAgentPrompt, updateAgent } from "../../apps/server/src/modules/team/roster.js";
import { savePrompt, activatePrompt } from "../../apps/server/src/modules/prompts/service.js";
import { updateSettings } from "../../apps/server/src/modules/settings/service.js";
import { buildDecisionInput } from "../../apps/server/src/modules/decisions/context.js";
import { reserveAttempt } from "../../apps/server/src/modules/agent/usage.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;
beforeEach(async () => {
  await pool.query("TRUNCATE simulations,daily_usage CASCADE");
  simulationId = (await createSimulation(db)).id;
});
afterAll(() => pool.end());

describe("team roster persistence", () => {
  it("seeds five distinct prompts and keeps the decision context on the lead", async () => {
    const agents = await listAgents(pool,simulationId);
    expect(agents).toHaveLength(5);
    expect(new Set(agents.map((a)=>a.prompt)).size).toBe(5);
    expect(agents.filter((a)=>a.isLead)).toHaveLength(1);
    expect((await buildDecisionInput(pool,simulationId)).prompt).toBe(agents.find((a)=>a.isLead)!.prompt);
    const leadPrompt = await savePrompt(db,{simulationId,name:"lead update",content:"Lead only"});
    await activatePrompt(db,leadPrompt.id);
    expect((await listAgents(pool,simulationId)).filter((a)=>a.prompt)).toHaveLength(5);
  });
  it("serializes concurrent creation at the ten-agent boundary", async () => {
    await Promise.all(Array.from({length:4},(_,i)=>createAgent(pool,simulationId,{name:`Extra ${i}`,prompt:"Analyze risk"})));
    const attempts = await Promise.allSettled([createAgent(pool,simulationId,{name:"Tenth",prompt:"Analyze"}),createAgent(pool,simulationId,{name:"Eleventh",prompt:"Analyze"})]);
    expect(attempts.filter((a)=>a.status==="fulfilled")).toHaveLength(1);
    expect(await listAgents(pool,simulationId)).toHaveLength(10);
  });
  it("preserves exactly one enabled lead and rejects writes while running", async () => {
    const agents = await listAgents(pool,simulationId);
    const lead = agents.find((a)=>a.isLead)!;
    await expect(updateAgent(pool,simulationId,lead.id,{enabled:false})).rejects.toThrow("lead");
    const replacement = agents.find((a)=>!a.isLead)!;
    await updateAgent(pool,simulationId,replacement.id,{isLead:true});
    await updateAgent(pool,simulationId,lead.id,{archived:true});
    expect((await listAgents(pool,simulationId)).filter((a)=>a.isLead)).toHaveLength(1);
    await pool.query("UPDATE agent_state SET paused=false WHERE simulation_id=$1",[simulationId]);
    await expect(saveAgentPrompt(pool,simulationId,replacement.id,{content:"changed"})).rejects.toThrow("paused");
    await expect(savePrompt(db,{simulationId,name:"unsafe",content:"changed"})).rejects.toThrow("paused");
  });
  it("versions and activates prompts independently and rejects another agent's prompt", async () => {
    const agents = await listAgents(pool,simulationId);
    const first = agents[0]!; const second = agents[1]!;
    const version = await saveAgentPrompt(pool,simulationId,first.id,{content:"New instructions"});
    await expect(activateAgentPrompt(pool,simulationId,second.id,version.id)).rejects.toThrow("unavailable");
    await activateAgentPrompt(pool,simulationId,first.id,version.id);
    const updated = await listAgents(pool,simulationId);
    expect(updated.find((a)=>a.id===first.id)!.prompt).toBe("New instructions");
    expect(updated.find((a)=>a.id===second.id)!.prompt).toBe(second.prompt);
    expect((await listAgentPrompts(pool,simulationId,first.id)).filter((p)=>p.active)).toHaveLength(1);
  });
  it("copies configuration and roster on reset without resetting daily usage", async () => {
    const roster = await listAgents(pool,simulationId);
    await updateAgent(pool,simulationId,roster[0]!.id,{name:"My analyst"});
    const defaults = (await pool.query("SELECT values FROM configurations WHERE simulation_id=$1",[simulationId])).rows[0].values;
    await updateSettings(db,{simulationId,expectedVersion:1,values:{...defaults,dailyAttemptLimit:999}});
    const client = await pool.connect();
    try { await client.query("BEGIN"); await reserveAttempt(client,"grok"); await client.query("COMMIT"); } finally { client.release(); }
    const run = (await pool.query("INSERT INTO team_runs(simulation_id,request_id,kind,generation,configuration_version) VALUES($1,$2,'discussion',0,2) RETURNING id",[simulationId,crypto.randomUUID()])).rows[0];
    await pool.query("INSERT INTO chat_messages(simulation_id,run_id,kind,content,status) VALUES($1,$2,'user','Queued work','queued')",[simulationId,run.id]);
    const next = await resetSimulation(db,{requestId:crypto.randomUUID(),startingCash:"2000"});
    expect((await pool.query("SELECT status FROM chat_messages WHERE run_id=$1",[run.id])).rows[0].status).toBe("cancelled");
    expect((await listAgents(pool,next.id)).map((a)=>a.name)).toContain("My analyst");
    expect((await pool.query("SELECT values FROM configurations WHERE simulation_id=$1",[next.id])).rows[0].values.dailyAttemptLimit).toBe(999);
    expect((await pool.query("SELECT attempts FROM daily_usage WHERE provider='all'")).rows[0].attempts).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM chat_messages WHERE simulation_id=$1",[next.id])).rows[0].count).toBe(0);
    await expect(updateAgent(pool,simulationId,roster[0]!.id,{name:"Old"})).rejects.toThrow("paused");
  });
});
