import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { ConfigurationVersion, SettingsUpdate } from "@paper-investor/contracts";
import { agentState, configurations, positions, simulations } from "../../db/schema.js";
import type { createDatabase } from "../../db/client.js";

type Database = ReturnType<typeof createDatabase>["db"];
const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/).refine((v) => Number.isFinite(Number(v)) && Number(v) <= 1);
const valuesSchema = z.object({
  provider: z.enum(["grok", "codex"]), model: z.string().min(1).max(100),
  assets: z.array(z.string().regex(/^[A-Z0-9]{2,20}USDT$/)).min(1).max(20).refine((assets) => new Set(assets).size === assets.length),
  cadenceSeconds: z.number().int().min(60).max(86_400), feeRate: decimal, slippageBps: z.number().int().min(0).max(500),
  maximumBuyPercent: decimal, maximumAssetExposure: decimal, maximumTotalExposure: decimal, dailyLossLimit: decimal,
}).strict();

export async function updateSettings(db: Database, input: SettingsUpdate): Promise<ConfigurationVersion> {
  const parsed = valuesSchema.safeParse(input.values);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || !parsed.success) throw new Error("Invalid settings or expected version");
  return db.transaction(async (tx) => {
    const [simulation] = await tx.select().from(simulations).where(and(eq(simulations.id, input.simulationId), eq(simulations.status, "active"))).limit(1);
    if (!simulation) throw new Error("Simulation is not active");
    const [state] = await tx.select().from(agentState).where(eq(agentState.simulationId, input.simulationId)).for("update").limit(1);
    if (!state?.paused || state.cycleRunning) throw new Error("Settings can only change while the agent is paused and idle");
    const [current] = await tx.select().from(configurations).where(eq(configurations.simulationId, input.simulationId)).orderBy(desc(configurations.version)).limit(1);
    if (!current || current.version !== input.expectedVersion) throw new Error("Configuration version conflict");
    const held = await tx.select({ symbol: positions.symbol }).from(positions).where(eq(positions.simulationId, input.simulationId));
    if (held.some(({ symbol }) => !parsed.data.assets.includes(symbol))) throw new Error("Settings cannot remove an asset with a position");
    const [configuration] = await tx.insert(configurations).values({ simulationId: input.simulationId, version: current.version + 1, values: parsed.data }).returning();
    if (!configuration) throw new Error("Configuration insert returned no row");
    return configuration as ConfigurationVersion;
  });
}
