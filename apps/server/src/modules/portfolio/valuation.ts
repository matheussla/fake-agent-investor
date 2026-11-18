import type { Pool, PoolClient } from "pg";
import type { PortfolioValuation } from "@paper-investor/contracts";
import { valuePortfolio } from "../accounting/positions.js";
import { latestQuotes } from "../market/latest-quotes.js";
import { withSimulationTransaction } from "../../db/simulation-transaction.js";

export function refreshValuation(pool: Pool, simulationId: string, now?: Date): Promise<PortfolioValuation> {
  return withSimulationTransaction(pool, simulationId, async (client, simulation) => {
    if (simulation.status !== "active") throw new Error("Active simulation not found");
    return (await refreshLockedValuation(client, simulationId, simulation.startingCash, now)).valuation;
  });
}

// The caller holds the simulation lock so cash, positions and realized profit share a trade boundary.
export async function refreshLockedValuation(client: PoolClient, simulationId: string, startingCash: string, referenceTime?: Date): Promise<{ valuation: PortfolioValuation; observedAt: Date }> {
  const balance = await client.query("SELECT COALESCE(sum(amount) FILTER (WHERE kind IN ('initial_funding','trade_cash','fee')),0)::text AS cash, COALESCE(sum(amount) FILTER (WHERE kind='realized_profit'),0)::text AS profit FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT'", [simulationId]);
  const positions = await client.query<{ symbol: string; quantity: string; costBasis: string }>('SELECT symbol,quantity::text,cost_basis::text AS "costBasis" FROM positions WHERE simulation_id=$1 AND quantity <> 0', [simulationId]);
  const quotes = await latestQuotes(client, positions.rows.map((position) => position.symbol));
  const now = referenceTime ?? new Date();
  const completed = valuePortfolio({ cash: balance.rows[0].cash, positions: positions.rows }, quotes, startingCash, balance.rows[0].profit, now.getTime());
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await client.query("INSERT INTO equity_history(simulation_id,cash,equity,realized_profit,unrealized_profit,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(simulation_id,observed_at) DO NOTHING", [simulationId, completed.cash, completed.equity, completed.realizedProfit, completed.unrealizedProfit, minute]);
  await recordDailyBaseline(client, simulationId, completed.equity, now);
  return { valuation: completed, observedAt: now };
}

export async function recordDailyBaseline(client: PoolClient, simulationId: string, equity: string, now = new Date()): Promise<void> {
  await client.query("INSERT INTO daily_baselines(simulation_id,utc_date,equity,observed_at) VALUES($1,$2,$3,$4) ON CONFLICT(simulation_id,utc_date) DO NOTHING", [simulationId, now.toISOString().slice(0, 10), equity, now]);
}
