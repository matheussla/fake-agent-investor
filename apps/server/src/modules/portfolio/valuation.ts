import type { Pool } from "pg";
import type { PortfolioValuation, Quote } from "@paper-investor/contracts";
import { valuePortfolio } from "../accounting/positions.js";

export async function refreshValuation(pool: Pool, simulationId: string, now = new Date()): Promise<PortfolioValuation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const simulation = await client.query("SELECT starting_cash::text FROM simulations WHERE id=$1 AND status='active'", [simulationId]);
    if (!simulation.rowCount) throw new Error("Active simulation not found");
    const balance = await client.query("SELECT COALESCE(sum(amount),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash')", [simulationId]);
    const positions = await client.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity <> 0", [simulationId]);
    const symbols = positions.rows.map((position) => position.symbol as string);
    const quoteResult = symbols.length ? await client.query("SELECT DISTINCT ON(symbol) symbol,bid::text,ask::text,bid_size::text AS \"bidSize\",ask_size::text AS \"askSize\",observed_at AS \"observedAt\",observed_at AS \"receivedAt\" FROM quote_samples WHERE symbol=ANY($1) ORDER BY symbol,observed_at DESC", [symbols]) : { rows: [] };
    const quotes = quoteResult.rows.map((quote) => ({ ...quote, observedAt: new Date(quote.observedAt).toISOString(), receivedAt: new Date(quote.receivedAt).toISOString() })) as Quote[];
    const valuation = valuePortfolio({ cash: balance.rows[0].cash, positions: positions.rows.map((position) => ({ symbol: position.symbol as string, quantity: position.quantity as string, costBasis: position.cost_basis as string })) }, quotes, simulation.rows[0].starting_cash, "0", now.getTime());
    const realized = await client.query("SELECT COALESCE(sum(amount),0)::text AS profit FROM ledger_entries WHERE simulation_id=$1 AND kind='realized_profit'", [simulationId]);
    const completed = { ...valuation, realizedProfit: realized.rows[0].profit as string };
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await client.query("INSERT INTO equity_history(simulation_id,cash,equity,realized_profit,unrealized_profit,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(simulation_id,observed_at) DO NOTHING", [simulationId, completed.cash, completed.equity, completed.realizedProfit, completed.unrealizedProfit, minute]);
    const utcDate = now.toISOString().slice(0, 10);
    await client.query("INSERT INTO daily_baselines(simulation_id,utc_date,equity,observed_at) VALUES($1,$2,$3,$4) ON CONFLICT(simulation_id,utc_date) DO NOTHING", [simulationId, utcDate, completed.equity, now]);
    await client.query("COMMIT");
    return completed;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
