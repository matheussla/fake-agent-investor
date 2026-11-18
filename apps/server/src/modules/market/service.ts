import type { Pool } from "pg";
import type { MarketDataProvider, MarketUpdate } from "@paper-investor/contracts";
import { BinanceMarketDataProvider } from "./ingestion.js";
import { persistMarketUpdate, pruneMarketHistory } from "./retention.js";
import { enforceDailyLoss } from "../risk/daily-loss.js";
import type { EventHub } from "../../http/sse.js";

export function startMarketServices(pool: Pool, events: EventHub, provider: MarketDataProvider = new BinanceMarketDataProvider()) {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let symbols: string[] = [];
  const shutdown = new AbortController();
  const lastQuoteWrite = new Map<string, number>();
  const pendingQuotes = new Set<string>();
  const writes = new Set<Promise<void>>();
  const signal = (timeout: number) => AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)]);
  const publishHealth = (status: "healthy" | "degraded" | "unavailable", detail: string) => events.publishMarket({ type: "health", health: { status, detail, lastMessageAt: status === "healthy" ? new Date().toISOString() : undefined } });
  const receive = (update: MarketUpdate) => {
    if (stopped) return;
    events.publishMarket(update);
    if (update.type !== "quote" && (update.type !== "candle" || !update.candle.closed)) return;
    const quote = update.type === "quote" ? update.quote : undefined;
    if (quote) {
      if (pendingQuotes.has(quote.symbol) || Date.parse(quote.receivedAt) - (lastQuoteWrite.get(quote.symbol) ?? -Infinity) < 1000) return;
      pendingQuotes.add(quote.symbol);
    }
    const write = (async () => {
      try {
        await persistMarketUpdate(pool, update);
        if (quote) lastQuoteWrite.set(quote.symbol, Date.parse(quote.receivedAt));
      } catch (error) { console.error("Market persistence failed", error); }
      finally { if (quote) pendingQuotes.delete(quote.symbol); }
    })();
    writes.add(write);
    void write.then(() => writes.delete(write));
  };

  const connect = async () => {
    if (stopped) return;
    try {
      const desired = await pool.query<{ symbol: string }>(`SELECT DISTINCT symbol FROM simulations s
        CROSS JOIN LATERAL (
          SELECT jsonb_array_elements_text(c.values->'assets') AS symbol FROM
            (SELECT values FROM configurations WHERE simulation_id=s.id ORDER BY version DESC LIMIT 1) c
          UNION SELECT symbol FROM positions WHERE simulation_id=s.id AND quantity <> 0
        ) markets WHERE s.status='active' ORDER BY symbol`);
      if (stopped) return;
      const requested = desired.rows.map(({ symbol }) => symbol).sort();
      events.setMarketSymbols(requested);
      if (requested.length === symbols.length && requested.every((symbol, index) => symbol === symbols[index])) {
        for (const symbol of symbols) events.publishMarket({ type: "health", health: { ...provider.health(symbol), symbol } });
        return;
      }
      const additions = requested.filter((symbol) => !symbols.includes(symbol));
      const available = additions.length ? await provider.instruments(signal(15_000)) : [];
      const supported = new Set(available.filter((item) => item.status === "trading").map((item) => item.symbol));
      const activeSymbols = requested.filter((symbol) => symbols.includes(symbol));
      await Promise.all(additions.map(async (symbol) => {
        try {
          if (!supported.has(symbol)) {
            events.publishMarket({ type: "health", health: { symbol, status: "unavailable", detail: `Binance market ${symbol} is unavailable` } });
            return;
          }
          const now = Date.now();
          // Binance returns the earliest 1000 rows; a longer window omits recent candles.
          const history = await provider.candles({ symbol, interval: "1m", startTime: new Date(now - 1000 * 60_000).toISOString(), endTime: new Date(now).toISOString() }, signal(15_000));
          for (const candle of history) {
            if (stopped) return;
            await persistMarketUpdate(pool, { type: "candle", candle });
          }
          const quote = await provider.quote(symbol, signal(10_000));
          if (stopped) return;
          await persistMarketUpdate(pool, { type: "quote", quote });
          activeSymbols.push(symbol);
        } catch (error) {
          if (!stopped) events.publishMarket({ type: "health", health: { symbol, status: "degraded", detail: error instanceof Error ? error.message : "Market bootstrap failed" } });
        }
      }));
      if (stopped) return;
      activeSymbols.sort();
      if (activeSymbols.length !== symbols.length || activeSymbols.some((symbol, index) => symbol !== symbols[index])) {
        unsubscribe?.();
        unsubscribe = undefined;
        symbols = [];
        if (activeSymbols.length) unsubscribe = provider.subscribe(activeSymbols, receive);
        symbols = activeSymbols;
        const active = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
        if (active.rows[0]) await enforceDailyLoss(pool, active.rows[0].id as string);
      }
      for (const symbol of symbols) events.publishMarket({ type: "health", health: { ...provider.health(symbol), symbol } });
    } catch (error) {
      if (stopped) return;
      publishHealth("degraded", error instanceof Error ? error.message : "Market bootstrap failed");
    } finally {
      if (!stopped) retry = setTimeout(() => { reconciliation = connect(); }, 5000);
    }
  };
  let reconciliation = connect();
  const ready = reconciliation;

  const valueTimer = setInterval(async () => {
    try {
      const active = await pool.query("SELECT id FROM simulations WHERE status='active' LIMIT 1");
      if (active.rows[0]) await enforceDailyLoss(pool, active.rows[0].id as string);
    } catch (error) { console.error("Portfolio valuation failed", error); }
  }, 60_000);
  const retentionTimer = setInterval(() => { void pruneMarketHistory(pool).catch((error: unknown) => console.error("Market retention failed", error)); }, 60 * 60_000);

  const stop = async () => {
    stopped = true;
    shutdown.abort();
    if (retry) clearTimeout(retry);
    clearInterval(valueTimer);
    clearInterval(retentionTimer);
    unsubscribe?.();
    await reconciliation;
    await Promise.all(writes);
  };
  return { ready, stop };
}
