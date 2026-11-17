import type { Pool } from "pg";
import type { DecisionInput } from "@paper-investor/contracts";

export async function buildDecisionInput(pool: Pool, simulationId: string): Promise<DecisionInput> {
  const [simulation, config, prompt, cash, positions] = await Promise.all([
    pool.query("SELECT starting_cash::text FROM simulations WHERE id=$1 AND status='active'", [simulationId]),
    pool.query("SELECT version,values FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [simulationId]),
    pool.query("SELECT version,content FROM prompts WHERE simulation_id=$1 AND active=true ORDER BY created_at DESC LIMIT 1", [simulationId]),
    pool.query("SELECT COALESCE(sum(amount),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [simulationId]),
    pool.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity<>0 ORDER BY symbol LIMIT 20", [simulationId]),
  ]);
  if (!simulation.rowCount || !config.rowCount || !prompt.rowCount) throw new Error("Decision context unavailable");
  const configuration = config.rows[0];
  const settings = configuration.values as Record<string, unknown>;
  const assets = Array.isArray(settings.assets) ? settings.assets.filter((value): value is string => typeof value === "string").slice(0, 20) : [];
  if (assets.length === 0) throw new Error("No configured assets available");
  const market = await pool.query("SELECT DISTINCT ON(symbol) symbol,bid::text,ask::text,bid_size::text AS \"bidSize\",ask_size::text AS \"askSize\",observed_at AS \"observedAt\",received_at AS \"receivedAt\" FROM quote_samples WHERE symbol=ANY($1) ORDER BY symbol,received_at DESC", [assets]);
  const quoteSnapshot = market.rows.map((quote) => ({ ...quote, observedAt: new Date(quote.observedAt).toISOString(), receivedAt: new Date(quote.receivedAt).toISOString() }));
  return {
    simulationId,
    snapshot: { startingCash: simulation.rows[0].starting_cash, cash: cash.rows[0].cash, positions: positions.rows },
    market: quoteSnapshot,
    limits: { provider: settings.provider, model: settings.model, assets, cadenceSeconds: settings.cadenceSeconds, feeRate: settings.feeRate, slippageBps: settings.slippageBps, maximumBuyPercent: settings.maximumBuyPercent, maximumAssetExposure: settings.maximumAssetExposure, maximumTotalExposure: settings.maximumTotalExposure, dailyLossLimit: settings.dailyLossLimit },
    prompt: prompt.rows[0].content as string,
    promptVersion: prompt.rows[0].version as number,
    configurationVersion: configuration.version as number,
  };
}
