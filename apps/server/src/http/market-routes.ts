import type { Candle, MarketDataProvider } from "@paper-investor/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BinanceMarketDataProvider } from "../modules/market/ingestion.js";

const symbolQuery = z.object({ symbol: z.string().regex(/^[\p{L}\p{N}]{1,40}USDT$/u) }).strict();
type MarketSymbol = { symbol: string; baseAsset: string; quoteAsset: string };

export function registerMarketRoutes(app: FastifyInstance, provider: Pick<MarketDataProvider, "instruments" | "candles"> = new BinanceMarketDataProvider()): void {
  let catalog: { data: MarketSymbol[]; expiresAt: number } | undefined;
  let catalogRequest: Promise<MarketSymbol[]> | undefined;
  const candleCache = new Map<string, { data: Promise<Candle[]>; expiresAt: number }>();

  const markets = (): Promise<MarketSymbol[]> => {
    if (catalog && catalog.expiresAt > Date.now()) return Promise.resolve(catalog.data);
    if (catalogRequest) return catalogRequest;
    catalogRequest = (async () => {
      try {
        const instruments = await provider.instruments(AbortSignal.timeout(10_000));
        const data = instruments.filter((item) => item.status === "trading" && item.quoteAsset === "USDT")
          .map(({ symbol, baseAsset, quoteAsset }) => ({ symbol, baseAsset, quoteAsset }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol));
        catalog = { data, expiresAt: Date.now() + 300_000 };
        return data;
      } finally { catalogRequest = undefined; }
    })();
    return catalogRequest;
  };

  app.get("/api/market-symbols", async (_request, reply) => {
    try { return await markets(); }
    catch (error) {
      app.log.warn({ err: error }, "Binance market catalog unavailable");
      return reply.code(502).send({ error: { code: "MARKET_UNAVAILABLE", message: "Could not load Binance markets. Try again shortly." } });
    }
  });

  app.get("/api/market-candles", async (request, reply) => {
    const parsed = symbolQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_QUERY", message: "A valid USDT market symbol is required" } });
    const { symbol } = parsed.data;
    try {
      if (!(await markets()).some((market) => market.symbol === symbol)) return reply.code(404).send({ error: { code: "UNKNOWN_MARKET", message: "This Binance USDT spot market is not available" } });
      const cached = candleCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) return await cached.data;
      // Bound browsing history in memory; only the selected market needs fresh candles.
      if (candleCache.size >= 50) candleCache.delete(candleCache.keys().next().value!);
      const now = Date.now();
      const data = (async () => {
        try {
          const candles = await provider.candles({ symbol, interval: "1m", startTime: new Date(now - 1000 * 60_000).toISOString(), endTime: new Date(now).toISOString() }, AbortSignal.timeout(10_000));
          return candles.filter((candle) => candle.closed);
        } catch (error) { candleCache.delete(symbol); throw error; }
      })();
      candleCache.set(symbol, { data, expiresAt: now + 15_000 });
      return await data;
    } catch (error) {
      app.log.warn({ err: error, symbol }, "Binance chart candles unavailable");
      return reply.code(502).send({ error: { code: "MARKET_UNAVAILABLE", message: "Could not load Binance candles. Try again shortly." } });
    }
  });
}
