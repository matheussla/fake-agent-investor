import { and, eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { NewSimulationInput, Simulation } from "@paper-investor/contracts";
import { agentState, configurations, ledgerEntries, prompts, resetRequests, simulations } from "../../db/schema.js";
import type { createDatabase } from "../../db/client.js";

type Database = ReturnType<typeof createDatabase>["db"];

export async function createSimulation(db: Database, input: NewSimulationInput = { startingCash: "10000" }): Promise<Simulation> {
  const cash = new Decimal(input.startingCash);
  if (!cash.isFinite() || cash.lte(0)) throw new Error("Starting cash must be a positive decimal");
  return db.transaction(async (tx) => {
    return insertSimulation(tx, cash);
  });
}

async function insertSimulation(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], cash: Decimal): Promise<Simulation> {
  const [simulation] = await tx.insert(simulations).values({ startingCash: cash.toFixed() }).returning();
  if (!simulation) throw new Error("Simulation insert returned no row");
  await tx.insert(configurations).values({ simulationId: simulation.id, version: 1, values: { provider: "grok", model: "grok-4.3", assets: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], cadenceSeconds: 300, feeRate: "0.001", slippageBps: 5, maximumBuyPercent: "0.10", maximumAssetExposure: "0.25", maximumTotalExposure: "0.50", dailyLossLimit: "0.05" } });
  await tx.insert(prompts).values({ simulationId: simulation.id, name: "Default strategy", version: 1, content: "Assess the supplied portfolio and market snapshot. Follow the risk limits exactly. Return hold unless a bounded spot trade is supported by the data.", active: true });
  await tx.insert(agentState).values({ simulationId: simulation.id, paused: true });
  await tx.insert(ledgerEntries).values({ simulationId: simulation.id, asset: "USDT", amount: cash.toFixed(), kind: "initial_funding" });
  return { id: simulation.id, status: simulation.status };
}

export async function resetSimulation(db: Database, input: { requestId: string; startingCash: string }): Promise<Simulation> {
  const cash = new Decimal(input.startingCash);
  if (!cash.isFinite() || cash.lte(0) || cash.decimalPlaces() > 18 || !/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Error("Invalid reset request");
  return db.transaction(async (tx) => {
    const [prior] = await tx.select({ simulationId: resetRequests.simulationId }).from(resetRequests).where(eq(resetRequests.requestId, input.requestId)).limit(1);
    if (prior) return { id: prior.simulationId, status: "archived" };
    const [current] = await tx.select().from(simulations).where(eq(simulations.status, "active")).for("update").limit(1);
    if (current) {
      const [state] = await tx.select({ generation: agentState.generation }).from(agentState).where(eq(agentState.simulationId, current.id)).for("update").limit(1);
      await tx.update(agentState).set({ paused: true, generation: (state?.generation ?? 0) + 1, pauseReason: "simulation_reset" }).where(eq(agentState.simulationId, current.id));
      await tx.update(simulations).set({ status: "archived", archivedAt: new Date() }).where(and(eq(simulations.id, current.id), eq(simulations.status, "active")));
    }
    const simulation = await insertSimulation(tx, cash);
    await tx.insert(resetRequests).values({ requestId: input.requestId, simulationId: simulation.id });
    return simulation;
  });
}

export async function getActiveSimulation(db: Database): Promise<Simulation | null> {
  const [simulation] = await db.select().from(simulations).where(eq(simulations.status, "active")).limit(1);
  return simulation ? { id: simulation.id, status: simulation.status } : null;
}

export async function ensureActiveSimulation(db: Database): Promise<Simulation> {
  const current = await getActiveSimulation(db);
  if (current) return current;
  try { return await createSimulation(db); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      const raced = await getActiveSimulation(db);
      if (raced) return raced;
    }
    throw error;
  }
}
