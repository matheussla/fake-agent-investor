import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, MarketDataProvider } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { startMarketServices } from "../../apps/server/src/modules/market/service.js";
import { EventHub } from "../../apps/server/src/http/sse.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
const instruments: Instrument[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((symbol) => ({ symbol, baseAsset: symbol.replace("USDT", ""), quoteAsset: "USDT", status: "trading", priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" }));
const provider = { instruments: vi.fn(async () => instruments), candles: vi.fn(async () => []), quote: vi.fn(async (symbol: string) => ({ symbol, bid: "10", ask: "11", bidSize: "1", askSize: "1", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() })), subscribe: vi.fn(() => () => undefined), health: () => ({ status: "healthy" as const }) } as unknown as MarketDataProvider;

beforeEach(async () => { await pool.query("TRUNCATE simulations,quote_samples,candles CASCADE"); await createSimulation(db); vi.clearAllMocks(); });
afterAll(async () => pool.end());

describe("market service lifecycle", () => {
  it("bootstraps configured markets, persists quotes, and closes its subscription", async () => {
    const events = new EventHub();
    const service = startMarketServices(pool, events, provider);
    await service.ready;
    const samples = await pool.query("SELECT count(*)::int AS count FROM quote_samples");
    expect(provider.subscribe).toHaveBeenCalledOnce();
    expect(samples.rows[0].count).toBe(3);
    await service.stop();
  });
});
