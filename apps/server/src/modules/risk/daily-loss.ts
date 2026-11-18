import type { Pool, PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { refreshLockedValuation } from "../portfolio/valuation.js";
import { withSimulationTransaction } from "../../db/simulation-transaction.js";

export function enforceDailyLoss(pool: Pool, simulationId: string, now?: Date): Promise<void> {
  return withSimulationTransaction(pool, simulationId, async (client, simulation) => {
    if (simulation.status !== "active") throw new Error("Active simulation not found");
    const { valuation, observedAt } = await refreshLockedValuation(client, simulationId, simulation.startingCash, now);
    await latchDailyLoss(client, simulationId, valuation.equity, observedAt);
  });
}

export async function latchDailyLoss(client: PoolClient, simulationId: string, equity: string, now = new Date()): Promise<boolean> {
  const result = await client.query("SELECT b.equity::text,c.values->>'dailyLossLimit' AS limit FROM daily_baselines b JOIN LATERAL (SELECT values FROM configurations WHERE simulation_id=b.simulation_id ORDER BY version DESC LIMIT 1) c ON true WHERE b.simulation_id=$1 AND b.utc_date=$2", [simulationId, now.toISOString().slice(0, 10)]);
  const baseline = result.rows[0];
  if (!baseline || !baseline.limit) throw new Error("Daily loss baseline unavailable");
  const threshold = new Decimal(baseline.equity).mul(new Decimal(1).minus(baseline.limit));
  if (new Decimal(equity).gt(threshold)) return false;
  await client.query("UPDATE agent_state SET paused=true,generation=generation+1,pause_reason='daily_loss_limit' WHERE simulation_id=$1 AND pause_reason IS DISTINCT FROM 'daily_loss_limit'", [simulationId]);
  return true;
}
