import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { BinanceMarketDataProvider } from "../modules/market/ingestion.js";

const instrument = (symbol: string, status = "trading", quoteAsset = "USDT") => ({ symbol, baseAsset: symbol.replace(quoteAsset, ""), quoteAsset, status, priceIncrement: "0.01", quantityIncrement: "1", minimumQuantity: "1", minimumNotional: "5" });
const headers = { host: "127.0.0.1:3000" };

describe("market browsing API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns active USDT markets outside the trading configuration and caches the catalog", async () => {
    const instruments = vi.spyOn(BinanceMarketDataProvider.prototype, "instruments").mockResolvedValue([instrument("XRPUSDT"), instrument("OLDUSDT", "unavailable"), instrument("ETHBTC", "trading", "BTC")] as never);
    const app = buildApp({ query: vi.fn() } as never);
    const responses = await Promise.all([app.inject({ url: "/api/market-symbols", headers }), app.inject({ url: "/api/market-symbols", headers })]);
    expect(responses[0].statusCode).toBe(200);
    expect(responses[0].json()).toEqual([{ symbol: "XRPUSDT", baseAsset: "XRP", quoteAsset: "USDT" }]);
    expect(instruments).toHaveBeenCalledOnce();
    await app.close();
  });

  it("loads and caches closed candles on demand without requiring stored history", async () => {
    vi.spyOn(BinanceMarketDataProvider.prototype, "instruments").mockResolvedValue([instrument("XRPUSDT")] as never);
    const candles = vi.spyOn(BinanceMarketDataProvider.prototype, "candles").mockResolvedValue([{ symbol: "XRPUSDT", closed: true }, { symbol: "XRPUSDT", closed: false }] as never);
    const app = buildApp({ query: vi.fn() } as never);
    const responses = await Promise.all([app.inject({ url: "/api/market-candles?symbol=XRPUSDT", headers }), app.inject({ url: "/api/market-candles?symbol=XRPUSDT", headers })]);
    expect(responses[0].statusCode).toBe(200);
    expect(responses[0].json()).toEqual([{ symbol: "XRPUSDT", closed: true }]);
    expect(candles).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects unknown markets, invalid input, and foreign origins", async () => {
    vi.spyOn(BinanceMarketDataProvider.prototype, "instruments").mockResolvedValue([]);
    const candles = vi.spyOn(BinanceMarketDataProvider.prototype, "candles");
    const app = buildApp({ query: vi.fn() } as never);
    expect((await app.inject({ url: "/api/market-candles?symbol=UNKNOWNUSDT", headers })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/market-candles?symbol=../bad", headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/market-symbols", headers: { ...headers, origin: "https://evil.example" } })).statusCode).toBe(403);
    expect(candles).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports upstream failures and allows a subsequent retry", async () => {
    const instruments = vi.spyOn(BinanceMarketDataProvider.prototype, "instruments").mockRejectedValueOnce(new Error("Binance exchangeInfo failed: 429")).mockResolvedValue([instrument("XRPUSDT")] as never);
    const app = buildApp({ query: vi.fn() } as never);
    expect((await app.inject({ url: "/api/market-symbols", headers })).statusCode).toBe(502);
    expect((await app.inject({ url: "/api/market-symbols", headers })).statusCode).toBe(200);
    expect(instruments).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("accepts Unicode asset symbols listed by Binance", async () => {
    vi.spyOn(BinanceMarketDataProvider.prototype, "instruments").mockResolvedValue([instrument("币安人生USDT")] as never);
    const candles = vi.spyOn(BinanceMarketDataProvider.prototype, "candles").mockResolvedValue([]);
    const app = buildApp({ query: vi.fn() } as never);
    const response = await app.inject({ url: `/api/market-candles?symbol=${encodeURIComponent("币安人生USDT")}`, headers });
    expect(response.statusCode).toBe(200);
    expect(candles).toHaveBeenCalledOnce();
    await app.close();
  });
});
