import { and, desc, eq, inArray } from "drizzle-orm";
import type { PromptVersion, SavePromptInput } from "@paper-investor/contracts";
import { prompts, simulations, agents, agentState, teamRuns } from "../../db/schema.js";
import type { createDatabase } from "../../db/client.js";

type Database = ReturnType<typeof createDatabase>["db"];

async function editable(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], simulationId: string) {
  const [simulation] = await tx.select().from(simulations).where(and(eq(simulations.id,simulationId),eq(simulations.status,"active"))).for("update").limit(1);
  const [state] = await tx.select().from(agentState).where(eq(agentState.simulationId,simulationId)).for("update").limit(1);
  const pending = await tx.select().from(teamRuns).where(and(eq(teamRuns.simulationId,simulationId),inArray(teamRuns.status,["queued","working"]))).limit(1);
  if (!simulation || !state?.paused || state.cycleRunning || pending.length) throw new Error("Prompt changes require a paused, idle simulation");
}

function validate(input: SavePromptInput): void {
  if (!input.name.trim() || input.name.trim().length > 80) throw new Error("Prompt name must contain 1 to 80 characters");
  if (!input.content.trim() || input.content.length > 12_000) throw new Error("Prompt content must contain 1 to 12000 characters");
}

export async function savePrompt(db: Database, input: SavePromptInput): Promise<PromptVersion> {
  validate(input);
  return db.transaction(async (tx) => {
    const [simulation] = await tx.select({ id: simulations.id }).from(simulations).where(and(eq(simulations.id, input.simulationId), eq(simulations.status, "active"))).limit(1);
    if (!simulation) throw new Error("Simulation is not active");
    await editable(tx,input.simulationId);
    const [lead] = await tx.select().from(agents).where(and(eq(agents.simulationId,input.simulationId),eq(agents.isLead,true))).limit(1);
    if (!lead) throw new Error("Lead unavailable");
    const [latest] = await tx.select().from(prompts).where(and(eq(prompts.simulationId, input.simulationId), eq(prompts.name, input.name.trim()),eq(prompts.agentId,lead.id))).orderBy(desc(prompts.version)).limit(1);
    const [prompt] = await tx.insert(prompts).values({ simulationId: input.simulationId, agentId:lead.id, name: input.name.trim(), version: (latest?.version ?? 0) + 1, content: input.content }).returning();
    if (!prompt) throw new Error("Prompt insert returned no row");
    return prompt;
  });
}

export async function activatePrompt(db: Database, promptVersionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(prompts).where(eq(prompts.id, promptVersionId)).limit(1);
    if (!target) throw new Error("Prompt version does not exist");
    const [simulation] = await tx.select().from(simulations).where(and(eq(simulations.id, target.simulationId), eq(simulations.status, "active"))).limit(1);
    if (!simulation) throw new Error("Simulation is not active");
    await editable(tx,target.simulationId);
    if (!target.agentId) throw new Error("Prompt agent unavailable");
    const [lead] = await tx.select().from(agents).where(and(eq(agents.id,target.agentId),eq(agents.isLead,true))).limit(1);
    if (!lead) throw new Error("Legacy prompts must belong to the lead");
    await tx.update(prompts).set({ active: false }).where(eq(prompts.agentId, target.agentId));
    await tx.update(prompts).set({ active: true }).where(eq(prompts.id, target.id));
  });
}

export async function activatePromptVersion(db: Database, promptId: string, promptVersionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [prompt] = await tx.select().from(prompts).where(eq(prompts.id, promptId)).limit(1);
    const [target] = await tx.select().from(prompts).where(eq(prompts.id, promptVersionId)).limit(1);
    if (!prompt || !target || prompt.simulationId !== target.simulationId || prompt.name !== target.name || prompt.agentId !== target.agentId) throw new Error("Prompt version does not belong to this prompt");
    const [simulation] = await tx.select().from(simulations).where(and(eq(simulations.id, prompt.simulationId), eq(simulations.status, "active"))).limit(1);
    if (!simulation) throw new Error("Simulation is not active");
    await editable(tx,target.simulationId);
    if (!target.agentId) throw new Error("Prompt agent unavailable");
    const [lead] = await tx.select().from(agents).where(and(eq(agents.id,target.agentId),eq(agents.isLead,true))).limit(1);
    if (!lead) throw new Error("Legacy prompts must belong to the lead");
    await tx.update(prompts).set({ active: false }).where(eq(prompts.agentId, target.agentId));
    await tx.update(prompts).set({ active: true }).where(eq(prompts.id, target.id));
  });
}
