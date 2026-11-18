import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { CreateAgentBodySchema, UpdateAgentBodySchema, AgentPromptBodySchema, ChatMessageBodySchema } from "@paper-investor/contracts/http";
import { listAgents, createAgent, updateAgent, listAgentPrompts, saveAgentPrompt, activateAgentPrompt } from "../modules/team/roster.js";
import { TeamRuntime, messageDto, runDto } from "../modules/team/runtime.js";
import type { EventHub } from "./sse.js";

const idSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({ simulationId: z.string().uuid().optional(), agentId: z.string().uuid().optional(), beforeRunId: z.string().uuid().optional(), after: z.string().regex(/^\d+$/).optional(), before: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();


export function registerTeamRoutes(app: FastifyInstance, pool: Pool, team: TeamRuntime, events: EventHub): void {
  const active = async () => { const row = (await pool.query("SELECT id FROM simulations WHERE status='active'")).rows[0]; if (!row) throw new Error("No active simulation"); return row.id as string; };
  const changed = (simulationId: string) => events.publish({ id: crypto.randomUUID(), type: "agents", occurredAt: new Date().toISOString(), simulationId, data: {} });
  app.get("/api/agents", async (request, reply) => { try { const query = querySchema.parse(request.query); return await listAgents(pool, query.simulationId ?? await active()); } catch (error) { return failed(reply,error); } });
  app.post("/api/agents", async (request, reply) => { try { const body = CreateAgentBodySchema.parse(request.body); const sim = await active(); const agent = await createAgent(pool,sim,body); changed(sim); return reply.code(201).send(agent); } catch (error) { return failed(reply,error); } });
  app.patch("/api/agents/:id", async (request, reply) => { try { const { id } = idSchema.parse(request.params); const body = UpdateAgentBodySchema.parse(request.body); const sim = await active(); const agent = await updateAgent(pool,sim,id,body); changed(sim); return agent; } catch (error) { return failed(reply,error); } });
  app.get("/api/agents/:id/prompts", async (request, reply) => { try { const { id } = idSchema.parse(request.params); const query = querySchema.parse(request.query); return await listAgentPrompts(pool,query.simulationId ?? await active(),id); } catch (error) { return failed(reply,error); } });
  app.post("/api/agents/:id/prompts", async (request, reply) => { try { const { id } = idSchema.parse(request.params); const body = AgentPromptBodySchema.parse(request.body); const sim = await active(); const prompt = await saveAgentPrompt(pool,sim,id,body); changed(sim); return reply.code(201).send(prompt); } catch (error) { return failed(reply,error); } });
  app.post("/api/agents/:id/prompts/:promptId/activate", async (request, reply) => { try { const { id,promptId } = z.object({id:z.string().uuid(),promptId:z.string().uuid()}).parse(request.params); z.object({}).strict().parse(request.body); const sim = await active(); await activateAgentPrompt(pool,sim,id,promptId); changed(sim); return { activated:true }; } catch (error) { return failed(reply,error); } });
  app.get("/api/chat/messages", async (request, reply) => {
    try {
      const query = querySchema.parse(request.query); const sim = query.simulationId ?? await active();
      const rows = (await pool.query(`SELECT m.*,sender.name AS sender_name,recipient.name AS recipient_name FROM chat_messages m LEFT JOIN agents sender ON sender.id=m.sender_agent_id LEFT JOIN agents recipient ON recipient.id=m.recipient_agent_id WHERE m.simulation_id=$1 AND ($2::uuid IS NULL OR m.sender_agent_id=$2 OR m.recipient_agent_id=$2) AND ($3::bigint IS NULL OR m.sequence>$3) AND ($4::bigint IS NULL OR m.sequence<$4) ORDER BY m.sequence ${query.after ? "ASC" : "DESC"} LIMIT $5`, [sim,query.agentId ?? null,query.after ?? null,query.before ?? null,query.limit])).rows;
      if (!query.after) rows.reverse();
      return { messages:rows.map(messageDto), nextCursor: rows.length ? String(rows[rows.length-1].sequence) : query.after ?? null };
    } catch (error) { return failed(reply,error); }
  });
  app.post("/api/chat/messages", async (request,reply) => { try { return reply.code(202).send(await team.enqueue(await active(),ChatMessageBodySchema.parse(request.body))); } catch (error) { return failed(reply,error); } });
  app.get("/api/team/runs", async (request,reply) => { try { const query = querySchema.parse(request.query); return (await pool.query("SELECT * FROM team_runs WHERE simulation_id=$1 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM team_runs WHERE id=$3 AND simulation_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $2",[query.simulationId ?? await active(),query.limit,query.beforeRunId ?? null])).rows.map(runDto); } catch (error) { return failed(reply,error); } });
  app.get("/api/team/runs/:id", async (request,reply) => { try { const { id } = idSchema.parse(request.params); const query = querySchema.parse(request.query); const row = (await pool.query("SELECT * FROM team_runs WHERE id=$1 AND simulation_id=$2",[id,query.simulationId ?? await active()])).rows[0]; if (!row) return reply.code(404).send({error:{code:"NOT_FOUND",message:"Run not found"}}); const turns = (await pool.query('SELECT id,agent_id AS "agentId",status,error,created_at AS "createdAt",finished_at AS "completedAt" FROM agent_turns WHERE run_id=$1 ORDER BY created_at,id',[id])).rows; return {run:runDto(row),turns}; } catch (error) { return failed(reply,error); } });
  app.post("/api/team/runs/:id/cancel", async (request,reply) => { try { const {id} = idSchema.parse(request.params); z.object({}).strict().parse(request.body); await team.cancelRun(await active(),id); return {cancelled:true}; } catch (error) { return failed(reply,error); } });
}
function failed(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({error:{code:"INVALID_INPUT",message:"Invalid request"}});
  const message = error instanceof Error ? error.message : "Request failed";
  const safe = /^(Team |Assign another|Invalid target|Idempotency conflict|No active simulation|Agent unavailable|Prompt unavailable)/.test(message) ? message : "Request conflicts with the current simulation state";
  return reply.code(409).send({error:{code:"STATE_CONFLICT",message:safe}});
}
