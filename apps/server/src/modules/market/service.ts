import type { Pool } from "pg";
import { BinanceMarketDataProvider } from "./ingestion.js";
import { persistMarketUpdate, pruneMarketHistory } from "./retention.js";
import { enforceDailyLoss } from "../risk/daily-loss.js";
import type { EventHub } from "../../http/sse.js";

const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export function startMarketServices(pool: Pool, events: EventHub, provider = new BinanceMarketDataProvider()) {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryCount = 0;
  const publishHealth = (status: "healthy" | "degraded" | "unavailable", detail: string) => events.publishMarket({ type: "health", health: { status, detail, lastMessageAt: status === "healthy" ? new Date().toISOString() : undefined } });

  const connect = async () => {
    if (stopped) return;
    try {
      const available = await provider.instruments(AbortSignal.timeout(15_000));
      const supported = new Set(available.filter((item) => item.status === "trading").map((item) => item.symbol));
      const activeSymbols = symbols.filter((symbol) => supported.has(symbol));
      if (activeSymbols.length !== symbols.length) throw new Error("One or more default Binance markets are unavailable");
      for (const symbol of activeSymbols) {
        const now = Date.now();
        const history = await provider.candles({ symbol, interval: "1m", startTime: new Date(now - 24 * 60 * 60 * 1000).toISOString(), endTime: new Date(now).toISOString() }, AbortSignal.timeout(15_000));
        for (const candle of history) await persistMarketUpdate(pool, { type: "candle", candle });
        const quote = await provider.quote(symbol, AbortSignal.timeout(10_000));
        await persistMarketUpdate(pool, { type: "quote", quote });
      }
      if (stopped) return;
      unsubscribe = provider.subscribe(activeSymbols, (update) => {
        events.publishMarket(update);
        void persistMarketUpdate(pool, update).catch((error: unknown) => console.error("Market persistence failed", error));
      });
      const active = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
      if (active.rows[0]) await enforceDailyLoss(pool, active.rows[0].id as string);
      retryCount = 0;
    } catch (error) {
      if (stopped) return;
      publishHealth("degraded", error instanceof Error ? error.message : "Market bootstrap failed");
      retryCount += 1;
      retry = setTimeout(() => { void connect(); }, Math.min(60_000, 1000 * 2 ** Math.min(retryCount, 6)));
    }
  };
  const ready = connect();

  const valueTimer = setInterval(async () => {
    try {
      const active = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
      if (active.rows[0]) await enforceDailyLoss(pool, active.rows[0].id as string);
    } catch (error) { console.error("Portfolio valuation failed", error); }
  }, 60_000);
  const retentionTimer = setInterval(() => { void pruneMarketHistory(pool).catch((error: unknown) => console.error("Market retention failed", error)); }, 60 * 60_000);
  const healthTimer = setInterval(() => {
    for (const symbol of symbols) events.publishMarket({ type: "health", health: provider.health(symbol) });
  }, 60_000);

  const stop = async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    clearInterval(valueTimer);
    clearInterval(retentionTimer);
    clearInterval(healthTimer);
    unsubscribe?.();
  };
  return { ready, stop };
}
