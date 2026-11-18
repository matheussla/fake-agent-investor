import type { Pool } from "pg";
import type { Candle, DecisionInput } from "@paper-investor/contracts";
import { latestQuotes } from "../market/latest-quotes.js";

export async function buildDecisionInput(pool: Pool, simulationId: string): Promise<DecisionInput> {
  const [simulation, config, prompt, cash, positions] = await Promise.all([
    pool.query("SELECT starting_cash::text FROM simulations WHERE id=$1 AND status='active'", [simulationId]),
    pool.query("SELECT version,values FROM configurations WHERE simulation_id=$1 ORDER BY version DESC LIMIT 1", [simulationId]),
    pool.query("SELECT version,content FROM prompts WHERE simulation_id=$1 AND active=true AND agent_id IN (SELECT id FROM agents WHERE simulation_id=$1 AND is_lead=true) ORDER BY created_at DESC LIMIT 1", [simulationId]),
    pool.query("SELECT COALESCE(sum(amount),0)::text AS cash FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [simulationId]),
    pool.query("SELECT symbol,quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1 AND quantity<>0 ORDER BY symbol LIMIT 20", [simulationId]),
  ]);
  if (!simulation.rowCount || !config.rowCount || !prompt.rowCount) throw new Error("Decision context unavailable");
  const configuration = config.rows[0];
  const settings = configuration.values as Record<string, unknown>;
  const assets = Array.isArray(settings.assets) ? settings.assets.filter((value): value is string => typeof value === "string").slice(0, 20) : [];
  if (assets.length === 0) throw new Error("No configured assets available");
  const capturedAt = new Date().toISOString();
  const [quoteSnapshot, history] = await Promise.all([
    latestQuotes(pool, assets),
    pool.query<Candle>(`SELECT c.symbol,c.open_time AS "openTime",c.close_time AS "closeTime",
      c.open::text,c.high::text,c.low::text,c.close::text,c.volume::text,c.closed
      FROM unnest($1::text[]) AS requested(symbol) CROSS JOIN LATERAL (
        SELECT * FROM candles WHERE symbol=requested.symbol AND closed=true AND close_time<=$2
          AND open_time>=$2::timestamptz-interval '2 hours'
        ORDER BY open_time DESC LIMIT 60
      ) c ORDER BY c.symbol,c.open_time`, [assets, capturedAt]),
  ]);
  return {
    simulationId, capturedAt,
    candles: history.rows.map((candle) => ({ ...candle, openTime: new Date(candle.openTime).toISOString(), closeTime: new Date(candle.closeTime).toISOString() })),
    snapshot: { startingCash: simulation.rows[0].starting_cash, cash: cash.rows[0].cash, positions: positions.rows },
    market: quoteSnapshot,
    limits: { dailyAttemptLimit: settings.dailyAttemptLimit ?? 300, provider: settings.provider, model: settings.model, assets, cadenceSeconds: settings.cadenceSeconds, feeRate: settings.feeRate, slippageBps: settings.slippageBps, maximumDecisionAgeSeconds: settings.maximumDecisionAgeSeconds ?? 60, maximumPriceMovementBps: settings.maximumPriceMovementBps ?? 50, maximumBuyPercent: settings.maximumBuyPercent, maximumAssetExposure: settings.maximumAssetExposure, maximumTotalExposure: settings.maximumTotalExposure, dailyLossLimit: settings.dailyLossLimit },
    prompt: prompt.rows[0].content as string,
    promptVersion: prompt.rows[0].version as number,
    configurationVersion: configuration.version as number,
  };
}
