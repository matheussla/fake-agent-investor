import type { Pool, PoolClient } from "pg";
import type { TeamAgent } from "@paper-investor/contracts";
import { CreateAgentBodySchema, UpdateAgentBodySchema, AgentPromptBodySchema } from "@paper-investor/contracts/http";

export async function assertTeamEditable(client: PoolClient, simulationId: string): Promise<void> {
  const simulation = await client.query("SELECT status FROM simulations WHERE id=$1 FOR UPDATE", [simulationId]);
  const state = await client.query("SELECT paused,cycle_running FROM agent_state WHERE simulation_id=$1 FOR UPDATE", [simulationId]);
  const pending = await client.query("SELECT id FROM team_runs WHERE simulation_id=$1 AND status IN ('queued','working') LIMIT 1", [simulationId]);
  if (simulation.rows[0]?.status !== "active" || !state.rows[0]?.paused || state.rows[0]?.cycle_running || pending.rowCount) throw new Error("Team changes require a paused, idle simulation");
}
async function mutation<T>(pool: Pool, simulationId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await assertTeamEditable(client, simulationId); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function listAgents(pool: Pool, simulationId: string): Promise<TeamAgent[]> {
  return (await pool.query(`SELECT a.id,a.simulation_id AS "simulationId",a.name,a.enabled,a.is_lead AS "isLead",a.archived,COALESCE(p.content,'') AS prompt,COALESCE(p.version,0) AS "promptVersion",COALESCE(t.status,CASE WHEN a.enabled THEN 'idle' ELSE 'disabled' END) AS status FROM agents a LEFT JOIN LATERAL (SELECT content,version FROM prompts WHERE agent_id=a.id AND active=true ORDER BY created_at DESC LIMIT 1) p ON true LEFT JOIN LATERAL (SELECT at.status FROM agent_turns at JOIN team_runs r ON r.id=at.run_id WHERE at.agent_id=a.id AND r.status IN ('queued','working') ORDER BY at.created_at DESC LIMIT 1) t ON true WHERE a.simulation_id=$1 ORDER BY a.created_at,a.id`, [simulationId])).rows;
}
export async function createAgent(pool: Pool, simulationId: string, input: { name: string; prompt: string }): Promise<TeamAgent> {
  const body = CreateAgentBodySchema.parse(input);
  const id = await mutation(pool, simulationId, async (client) => {
    const count = await client.query("SELECT count(*)::int AS count FROM agents WHERE simulation_id=$1 AND archived=false", [simulationId]);
    if (count.rows[0].count >= 10) throw new Error("Team supports at most ten agents");
    const row = await client.query("INSERT INTO agents(simulation_id,name) VALUES($1,$2) RETURNING id", [simulationId,body.name]);
    await client.query("INSERT INTO prompts(simulation_id,agent_id,name,version,content,active) VALUES($1,$2,'Instructions',1,$3,true)", [simulationId,row.rows[0].id,body.prompt]);
    return row.rows[0].id as string;
  });
  return (await listAgents(pool,simulationId)).find((a) => a.id === id)!;
}
export async function updateAgent(pool: Pool, simulationId: string, id: string, input: { name?: string; enabled?: boolean; isLead?: boolean; archived?: boolean }): Promise<TeamAgent> {
  const body = UpdateAgentBodySchema.parse(input);
  await mutation(pool,simulationId, async (client) => {
    const row = await client.query("SELECT * FROM agents WHERE id=$1 AND simulation_id=$2",[id,simulationId]);
    const agent = row.rows[0]; if (!agent) throw new Error("Agent unavailable");
    const lead = body.isLead ?? agent.is_lead;
    const enabled = body.enabled ?? agent.enabled;
    const archived = body.archived ?? agent.archived;
    if ((agent.is_lead && !lead) || (lead && (!enabled || archived))) throw new Error("Assign another enabled lead before disabling the lead");
    if (!archived && agent.archived) { const count = await client.query("SELECT count(*)::int AS count FROM agents WHERE simulation_id=$1 AND archived=false",[simulationId]); if (count.rows[0].count >= 10) throw new Error("Team supports at most ten agents"); }
    if (lead) await client.query("UPDATE agents SET is_lead=false WHERE simulation_id=$1 AND id<>$2",[simulationId,id]);
    await client.query("UPDATE agents SET name=$3,enabled=$4,is_lead=$5,archived=$6 WHERE id=$1 AND simulation_id=$2",[id,simulationId,body.name ?? agent.name,enabled,lead,archived]);
  });
  return (await listAgents(pool,simulationId)).find((a) => a.id === id)!;
}
export async function listAgentPrompts(pool: Pool, simulationId: string, agentId: string) {
  return (await pool.query('SELECT id,agent_id AS "agentId",name,version,content,active,created_at AS "createdAt" FROM prompts WHERE simulation_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC',[simulationId,agentId])).rows;
}
export async function saveAgentPrompt(pool: Pool, simulationId: string, agentId: string, input: {content:string}) {
  const body = AgentPromptBodySchema.parse(input);
  return mutation(pool,simulationId, async (client) => {
    const agent = await client.query("SELECT id FROM agents WHERE id=$1 AND simulation_id=$2 AND archived=false",[agentId,simulationId]);
    if (!agent.rowCount) throw new Error("Agent unavailable");
    return (await client.query(`INSERT INTO prompts(simulation_id,agent_id,name,version,content) SELECT $1,$2,'Instructions',COALESCE(max(version),0)+1,$3 FROM prompts WHERE agent_id=$2 AND name='Instructions' RETURNING id,agent_id AS "agentId",name,version,content,active,created_at AS "createdAt"`,[simulationId,agentId,body.content])).rows[0];
  });
}
export async function activateAgentPrompt(pool: Pool, simulationId: string, agentId: string, promptId: string) {
  await mutation(pool,simulationId, async (client) => {
    const target = await client.query("SELECT p.id FROM prompts p JOIN agents a ON a.id=p.agent_id WHERE p.id=$1 AND p.agent_id=$2 AND p.simulation_id=$3 AND a.archived=false",[promptId,agentId,simulationId]);
    if (!target.rowCount) throw new Error("Prompt unavailable");
    await client.query("UPDATE prompts SET active=false WHERE agent_id=$1",[agentId]);
    await client.query("UPDATE prompts SET active=true WHERE id=$1",[promptId]);
  });
}
