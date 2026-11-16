import { describe, expect, it, vi } from "vitest";
import { BinanceMarketDataProvider } from "./ingestion.js";

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("Binance public market adapter", () => {
  it("normalizes trading rules and rejects an unavailable REST response", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ symbols: [{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" }, { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "NOTIONAL", minNotional: "5" }] }] }));
    const provider = new BinanceMarketDataProvider(fetcher);
    await expect(provider.instruments(new AbortController().signal)).resolves.toMatchObject([{ symbol: "BTCUSDT", status: "trading", quantityIncrement: "0.001", minimumNotional: "5" }]);
    fetcher.mockResolvedValue({ ok: false, status: 429 } as Response);
    await expect(provider.instruments(new AbortController().signal)).rejects.toThrow("429");
  });

  it("parses candles with UTC timestamps and close state", async () => {
    const fetcher = vi.fn().mockResolvedValue(response([[Date.now() - 120000, "10", "12", "9", "11", "50", Date.now() - 60000]]));
    const provider = new BinanceMarketDataProvider(fetcher);
    const rows = await provider.candles({ symbol: "BTCUSDT", interval: "1m", startTime: new Date(Date.now() - 180000).toISOString(), endTime: new Date().toISOString() }, new AbortController().signal);
    expect(rows[0]).toMatchObject({ symbol: "BTCUSDT", open: "10", close: "11", closed: true });
  });

  it("closes a subscription cleanly", () => {
    const socket = { addEventListener: vi.fn(), close: vi.fn() };
    const provider = new BinanceMarketDataProvider(fetch, () => socket);
    provider.subscribe(["BTCUSDT"], () => undefined)();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(provider.health().status).toBe("unavailable");
  });

  it("drops duplicate and out-of-order book updates", async () => {
    const listeners = new Map<string, (event: MessageEvent | Event) => void>();
    const socket = { addEventListener: vi.fn((type: string, listener: (event: MessageEvent | Event) => void) => listeners.set(type, listener)), close: vi.fn() };
    const provider = new BinanceMarketDataProvider(vi.fn().mockResolvedValue(response([])), () => socket);
    const updates: Array<{ type: string }> = [];
    const stop = provider.subscribe(["BTCUSDT"], (event) => updates.push(event));
    listeners.get("open")?.(new Event("open"));
    const send = (id: number) => listeners.get("message")?.({ data: JSON.stringify({ stream: "btcusdt@bookTicker", data: { s: "BTCUSDT", u: id, b: "100", a: "101", B: "1", A: "1" } }) } as MessageEvent);
    send(10); send(10); send(9);
    await Promise.resolve();
    expect(updates.filter((event) => event.type === "quote")).toHaveLength(1);
    expect(provider.health("ETHUSDT").status).toBe("degraded");
    stop();
  });
});
