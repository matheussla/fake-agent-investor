import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, MarketDataProvider, Quote } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { startMarketServices } from "../../apps/server/src/modules/market/service.js";
import { EventHub } from "../../apps/server/src/http/sse.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
const instruments: Instrument[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"].map((symbol) => ({ symbol, baseAsset: symbol.replace("USDT", ""), quoteAsset: "USDT", status: "trading", priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" }));
const provider = { instruments: vi.fn(async () => instruments), candles: vi.fn(async () => []), quote: vi.fn(async (symbol: string) => ({ symbol, bid: "10", ask: "11", bidSize: "1", askSize: "1", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() })), subscribe: vi.fn(() => () => undefined), health: () => ({ status: "healthy" as const }) } as unknown as MarketDataProvider;

let service: ReturnType<typeof startMarketServices> | undefined;
beforeEach(async () => {
  await pool.query("TRUNCATE simulations,quote_samples,candles CASCADE");
  await createSimulation(db);
  vi.clearAllMocks();
  vi.mocked(provider.candles).mockResolvedValue([]);
  vi.mocked(provider.subscribe).mockReturnValue(() => undefined);
});
afterEach(async () => { await service?.stop(); service = undefined; vi.restoreAllMocks(); });
afterAll(async () => pool.end());

async function configure(assets: string[]) {
  await pool.query("INSERT INTO configurations(simulation_id,version,values) SELECT simulation_id,version+1,jsonb_set(values,'{assets}',$1::jsonb) FROM configurations ORDER BY version DESC LIMIT 1", [JSON.stringify(assets)]);
}

describe("market service lifecycle", () => {
  it("bootstraps configured markets, persists quotes, and closes its subscription", async () => {
    const events = new EventHub();
    service = startMarketServices(pool, events, provider);
    await service.ready;
    const samples = await pool.query("SELECT count(*)::int AS count FROM quote_samples");
    expect(provider.subscribe).toHaveBeenCalledOnce();
    expect(samples.rows[0].count).toBe(3);
    await service.stop();
  });

  it("loads the saved watchlist instead of the default symbols", async () => {
    await configure(["XRPUSDT"]);
    service = startMarketServices(pool, new EventHub(), provider);
    await service.ready;
    const samples = await pool.query("SELECT DISTINCT symbol FROM quote_samples ORDER BY symbol");
    expect(samples.rows).toEqual([{ symbol: "XRPUSDT" }]);
    expect(provider.subscribe).toHaveBeenLastCalledWith(["XRPUSDT"], expect.any(Function));
  });

  it("reconciles changes while keeping held markets and avoiding unchanged reconnects", async () => {
    const events = new EventHub();
    const close = vi.fn();
    vi.mocked(provider.subscribe).mockReturnValue(close);
    service = startMarketServices(pool, events, provider);
    await service.ready;
    await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) SELECT id,'BTCUSDT',1,10 FROM simulations WHERE status='active'");
    events.publishMarket({ type: "health", health: { symbol: "SOLUSDT", status: "unavailable" } });
    await configure(["ETHUSDT", "XRPUSDT"]);
    await expect.poll(async () => (await pool.query("SELECT count(*)::int AS count FROM quote_samples WHERE symbol='XRPUSDT'")).rows[0].count, { timeout: 8000 }).toBe(1);
    await expect.poll(() => vi.mocked(provider.subscribe).mock.lastCall?.[0]).toEqual(["BTCUSDT", "ETHUSDT", "XRPUSDT"]);
    expect(close).toHaveBeenCalledOnce();
    await expect.poll(() => events.health()).not.toBe("unavailable");
    await configure(["XRPUSDT", "ETHUSDT"]);
    await new Promise((resolve) => setTimeout(resolve, 5500));
    expect(provider.subscribe).toHaveBeenCalledTimes(2);
    expect(provider.candles).toHaveBeenCalledTimes(4);
  }, 15000);

  it("keeps working markets when one configured market is unavailable", async () => {
    await configure(["BTCUSDT", "UNKNOWNUSDT"]);
    const events = new EventHub();
    service = startMarketServices(pool, events, provider);
    await service.ready;
    expect(provider.subscribe).toHaveBeenCalledWith(["BTCUSDT"], expect.any(Function));
    expect(events.health()).toBe("unavailable");
    await configure(["BTCUSDT"]);
    await expect.poll(() => events.health(), { timeout: 8000 }).toBe("healthy");
    expect(provider.subscribe).toHaveBeenCalledOnce();
  }, 10000);

  it("does not drop the existing subscription if a new market fails to bootstrap", async () => {
    await configure(["BTCUSDT"]);
    service = startMarketServices(pool, new EventHub(), provider);
    await service.ready;
    vi.spyOn(provider, "candles").mockRejectedValue(new Error("Exchange timeout"));
    await configure(["BTCUSDT", "XRPUSDT"]);
    await expect.poll(() => vi.mocked(provider.candles).mock.calls.length, { timeout: 8000 }).toBe(2);
    expect(provider.subscribe).toHaveBeenCalledOnce();
  }, 10000);

  it("bounds quote persistence during bursts while publishing every live quote", async () => {
    const events = new EventHub();
    service = startMarketServices(pool, events, provider);
    await service.ready;
    const listener = vi.fn();
    events.subscribe(listener);
    const connect = vi.spyOn(pool, "connect");
    const emit = vi.mocked(provider.subscribe).mock.lastCall![1];
    const receivedAt = new Date(Date.now() + 1000).toISOString();
    const quote: Quote = { symbol: "BTCUSDT", bid: "12", ask: "13", bidSize: "1", askSize: "1", observedAt: receivedAt, receivedAt };
    for (let index = 0; index < 500; index++) emit({ type: "quote", quote });
    expect(listener).toHaveBeenCalledTimes(500);
    expect(connect).toHaveBeenCalledOnce();
    await expect.poll(async () => (await pool.query("SELECT count(*)::int AS count FROM quote_samples WHERE symbol='BTCUSDT'")).rows[0].count).toBe(2);
  });

  it("retries quote persistence after a failed write", async () => {
    service = startMarketServices(pool, new EventHub(), provider);
    await service.ready;
    const connect = vi.spyOn(pool, "connect").mockRejectedValueOnce(new Error("Database temporarily unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const emit = vi.mocked(provider.subscribe).mock.lastCall![1];
    const receivedAt = new Date(Date.now() + 1000).toISOString();
    const quote: Quote = { symbol: "BTCUSDT", bid: "12", ask: "13", bidSize: "1", askSize: "1", observedAt: receivedAt, receivedAt };
    emit({ type: "quote", quote });
    await expect.poll(() => error.mock.calls.length).toBe(1);
    emit({ type: "quote", quote });
    expect(connect).toHaveBeenCalledTimes(2);
    await expect.poll(async () => (await pool.query("SELECT count(*)::int AS count FROM quote_samples WHERE symbol='BTCUSDT'")).rows[0].count).toBe(2);
  });

  it("aborts bootstrap on shutdown without opening a subscription", async () => {
    const started = Promise.withResolvers<void>();
    vi.mocked(provider.candles).mockImplementation((_request, signal) => {
      started.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    service = startMarketServices(pool, new EventHub(), provider);
    await started.promise;
    await service.stop();
    await service.ready;
    expect(provider.subscribe).not.toHaveBeenCalled();
  });
});

it("bootstraps recent candles within Binance's 1000-row response cap", async () => {
  vi.mocked(provider.candles).mockImplementation(async (request) => {
    const close = Math.min(Date.parse(request.endTime), Date.parse(request.startTime) + 1000 * 60_000) - 1;
    return [{ symbol: request.symbol, openTime: new Date(close - 59_999).toISOString(), closeTime: new Date(close).toISOString(), open: "10", high: "11", low: "9", close: "10", volume: "1", closed: true }];
  });
  const started = Date.now();
  service = startMarketServices(pool, new EventHub(), provider);
  await service.ready;
  const latest = (await pool.query("SELECT max(close_time) AS time FROM candles")).rows[0].time as Date;
  expect(latest.getTime()).toBeGreaterThanOrEqual(started - 60_000);
});
