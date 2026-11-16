import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { NewSimulationInput, Simulation } from "@paper-investor/contracts";
import { agentState, configurations, ledgerEntries, prompts, simulations } from "../../db/schema.js";
import type { createDatabase } from "../../db/client.js";

type Database = ReturnType<typeof createDatabase>["db"];

export async function createSimulation(db: Database, input: NewSimulationInput = { startingCash: "10000" }): Promise<Simulation> {
  const cash = new Decimal(input.startingCash);
  if (!cash.isFinite() || cash.lte(0)) throw new Error("Starting cash must be a positive decimal");
  return db.transaction(async (tx) => {
    const [simulation] = await tx.insert(simulations).values({ startingCash: cash.toFixed() }).returning();
    if (!simulation) throw new Error("Simulation insert returned no row");
    await tx.insert(configurations).values({ simulationId: simulation.id, version: 1, values: { provider: "grok", model: "grok-4.3", assets: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], cadenceSeconds: 300, feeRate: "0.001", slippageBps: 5, maximumBuyPercent: "0.10", maximumAssetExposure: "0.25", maximumTotalExposure: "0.50", dailyLossLimit: "0.05" } });
    await tx.insert(prompts).values({ simulationId: simulation.id, name: "Default strategy", version: 1, content: "Assess the supplied portfolio and market snapshot. Follow the risk limits exactly. Return hold unless a bounded spot trade is supported by the data.", active: true });
    await tx.insert(agentState).values({ simulationId: simulation.id, paused: true });
    await tx.insert(ledgerEntries).values({ simulationId: simulation.id, asset: "USDT", amount: cash.toFixed(), kind: "initial_funding" });
    return { id: simulation.id, status: simulation.status };
  });
}

export async function getActiveSimulation(db: Database): Promise<Simulation | null> {
  const [simulation] = await db.select().from(simulations).where(eq(simulations.status, "active")).limit(1);
  return simulation ? { id: simulation.id, status: simulation.status } : null;
}
