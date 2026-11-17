import type { Pool } from "pg";
import { refreshValuation } from "../portfolio/valuation.js";

export async function enforceDailyLoss(pool: Pool, simulationId: string, now = new Date()): Promise<void> {
  const valuation = await refreshValuation(pool, simulationId, now);
  const date = now.toISOString().slice(0, 10);
  const result = await pool.query("SELECT b.equity::text,c.values->>'dailyLossLimit' AS limit FROM daily_baselines b JOIN LATERAL (SELECT values FROM configurations WHERE simulation_id=b.simulation_id ORDER BY version DESC LIMIT 1) c ON true WHERE b.simulation_id=$1 AND b.utc_date=$2", [simulationId, date]);
  const baseline = result.rows[0];
  if (!baseline || !baseline.limit) throw new Error("Daily loss baseline unavailable");
  const threshold = Number(baseline.equity) * (1 - Number(baseline.limit));
  if (Number(valuation.equity) > threshold) return;
  await pool.query("UPDATE agent_state SET paused=true,generation=generation+1,pause_reason='daily_loss_limit' WHERE simulation_id=$1 AND pause_reason IS DISTINCT FROM 'daily_loss_limit'", [simulationId]);
}
