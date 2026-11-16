import type { Pool } from "pg";
import type { MarketUpdate } from "@paper-investor/contracts";

export async function persistMarketUpdate(pool: Pool, update: MarketUpdate): Promise<void> {
  if (update.type === "quote") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [update.quote.symbol]);
      const result = await client.query("SELECT max(received_at) AS last FROM quote_samples WHERE symbol=$1", [update.quote.symbol]);
      const last = result.rows[0]?.last as Date | null;
      if (!last || Date.parse(update.quote.receivedAt) - last.getTime() >= 1000) {
        await client.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(symbol,observed_at) DO NOTHING", [update.quote.symbol, update.quote.bid, update.quote.ask, update.quote.bidSize, update.quote.askSize, update.quote.observedAt, update.quote.receivedAt]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } else if (update.type === "candle" && update.candle.closed) {
    const candle = update.candle;
    await pool.query("INSERT INTO candles(symbol,open_time,close_time,open,high,low,close,volume,closed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT(symbol,open_time) DO UPDATE SET close_time=EXCLUDED.close_time,open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,closed=true", [candle.symbol, candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close, candle.volume]);
  }
}

export async function pruneMarketHistory(pool: Pool, now = new Date()): Promise<{ quotes: number; candles: number }> {
  const quotes = await pool.query("DELETE FROM quote_samples WHERE observed_at < $1 RETURNING id", [new Date(now.getTime() - 24 * 60 * 60 * 1000)]);
  const candles = await pool.query("DELETE FROM candles WHERE closed=true AND close_time < $1 RETURNING id", [new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)]);
  return { quotes: quotes.rowCount ?? 0, candles: candles.rowCount ?? 0 };
}
