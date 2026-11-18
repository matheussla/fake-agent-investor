import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceMarketDataProvider } from "./ingestion.js";

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Binance public market adapter", () => {
  it("normalizes trading rules and rejects an unavailable REST response", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ symbols: [{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" }, { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "NOTIONAL", minNotional: "5" }] }] }));
    const provider = new BinanceMarketDataProvider(fetcher);
    await expect(provider.instruments(new AbortController().signal)).resolves.toMatchObject([{ symbol: "BTCUSDT", status: "trading", quantityIncrement: "0.001", minimumNotional: "5" }]);
    fetcher.mockResolvedValue({ ok: false, status: 429 } as Response);
    await expect(new BinanceMarketDataProvider(fetcher).instruments(new AbortController().signal)).rejects.toThrow("429");
  });

  it("uses fresh instrument metadata and rejects expired metadata when refresh fails", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(response({ symbols: [] }));
    const provider = new BinanceMarketDataProvider(fetcher);
    const signal = new AbortController().signal;
    await provider.instruments(signal);
    await vi.advanceTimersByTimeAsync(299_999);
    await provider.instruments(signal);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    fetcher.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await expect(provider.instruments(signal)).rejects.toThrow("503");
    await expect(provider.instruments(signal)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("coalesces metadata requests without sharing caller cancellation", async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((finish) => { resolve = finish; });
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending);
    const provider = new BinanceMarketDataProvider(fetcher);
    const caller = new AbortController();
    const first = provider.instruments(caller.signal);
    const second = provider.instruments(new AbortController().signal);
    const cancelled = expect(first).rejects.toThrow("Caller cancelled");
    caller.abort(new Error("Caller cancelled"));
    resolve(response({ symbols: [] }));
    await cancelled;
    await expect(second).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
  });

  it("rejects an already cancelled metadata caller before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new BinanceMarketDataProvider(fetcher);
    await expect(provider.instruments(AbortSignal.abort(new Error("Cancelled")))).rejects.toThrow("Cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("times out a stalled metadata fetch and allows a later retry", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const provider = new BinanceMarketDataProvider(fetcher);
    const first = provider.instruments(new AbortController().signal);
    const second = provider.instruments(new AbortController().signal);
    await expect(Promise.all([first, second])).rejects.toMatchObject({ name: "TimeoutError" });
    fetcher.mockResolvedValue(response({ symbols: [] }));
    await expect(provider.instruments(new AbortController().signal)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns cached quotes only while both timestamps are fresh and not in the future", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const fetcher = vi.fn().mockResolvedValue(response({ bidPrice: "10", askPrice: "11", bidQty: "1", askQty: "1" }));
    const provider = new BinanceMarketDataProvider(fetcher);
    expect(provider.cachedQuote("BTCUSDT")).toBeUndefined();
    const quote = await provider.quote("BTCUSDT", new AbortController().signal);
    expect(provider.cachedQuote("BTCUSDT")).toEqual(quote);
    vi.setSystemTime(now + 5000);
    expect(provider.cachedQuote("BTCUSDT")).toEqual(quote);
    vi.setSystemTime(now + 5001);
    expect(provider.cachedQuote("BTCUSDT")).toBeUndefined();
    vi.setSystemTime(now - 1);
    expect(provider.cachedQuote("BTCUSDT")).toBeUndefined();
    vi.setSystemTime(now);
    quote.observedAt = new Date(now - 5001).toISOString();
    expect(provider.cachedQuote("BTCUSDT")).toBeUndefined();
    quote.observedAt = "invalid";
    expect(provider.cachedQuote("BTCUSDT")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
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

  it("ignores old socket events and cleanup after replacing a subscription", async () => {
    vi.useFakeTimers();
    const sockets: Array<{ listeners: Map<string, (event: MessageEvent | Event) => void>; addEventListener: (type: string, listener: (event: MessageEvent | Event) => void) => void; close: ReturnType<typeof vi.fn> }> = [];
    const createSocket = vi.fn(() => {
      const listeners = new Map<string, (event: MessageEvent | Event) => void>();
      const socket = { listeners, addEventListener: (type: string, listener: (event: MessageEvent | Event) => void) => { listeners.set(type, listener); }, close: vi.fn() };
      sockets.push(socket);
      return socket;
    });
    const provider = new BinanceMarketDataProvider(vi.fn().mockResolvedValue(response([])), createSocket);
    const oldUpdates = vi.fn();
    const stopOld = provider.subscribe(["BTCUSDT"], oldUpdates);
    const stop = provider.subscribe(["XRPUSDT"], () => undefined);
    try {
      sockets[0]!.listeners.get("close")!(new Event("close"));
      sockets[0]!.listeners.get("message")!({ data: JSON.stringify({ stream: "btcusdt@bookTicker", data: { s: "BTCUSDT", u: 1, b: "100", a: "101", B: "1", A: "1" } }) } as MessageEvent);
      await vi.advanceTimersByTimeAsync(2000);
      expect(createSocket).toHaveBeenCalledTimes(2);
      expect(oldUpdates).not.toHaveBeenCalled();
      stopOld();
      expect(sockets[1]!.close).not.toHaveBeenCalled();
    } finally { stop(); vi.useRealTimers(); }
  });
});
