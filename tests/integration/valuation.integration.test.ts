import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { persistMarketUpdate, pruneMarketHistory } from "../../apps/server/src/modules/market/retention.js";
import { refreshValuation } from "../../apps/server/src/modules/portfolio/valuation.js";
import { buildApp } from "../../apps/server/src/app.js";
import { EventHub } from "../../apps/server/src/http/sse.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;

beforeEach(async () => {
  await pool.query("TRUNCATE simulations, quote_samples, candles CASCADE");
  simulationId = (await createSimulation(db)).id;
});
afterAll(async () => pool.end());

describe("market history and portfolio valuation", () => {
  it("stores quotes and closed candles, retaining requested history windows", async () => {
    const now = new Date();
    const quoteUpdate = (offset: number) => ({ type: "quote" as const, quote: { symbol: "BTCUSDT", bid: "100", ask: "101", bidSize: "2", askSize: "3", observedAt: now.toISOString(), receivedAt: new Date(now.getTime() + offset).toISOString() } });
    await Promise.all([persistMarketUpdate(pool, quoteUpdate(0)), persistMarketUpdate(pool, quoteUpdate(200))]);
    await persistMarketUpdate(pool, { type: "candle", candle: { symbol: "BTCUSDT", openTime: now.toISOString(), closeTime: now.toISOString(), open: "100", high: "102", low: "99", close: "101", volume: "5", closed: true } });
    const old = new Date(now.getTime() - 91 * 86400_000);
    await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('OLDUSDT',1,1,1,1,$1,$1)", [old]);
    const result = await pruneMarketHistory(pool, now);
    const stored = await pool.query("SELECT count(*)::int AS count FROM candles WHERE symbol='BTCUSDT' AND closed");
    const samples = await pool.query("SELECT count(*)::int AS count FROM quote_samples WHERE symbol='BTCUSDT'");
    expect(result.quotes).toBe(1);
    expect(stored.rows[0].count).toBe(1);
    expect(samples.rows[0].count).toBe(1);
  });

  it("records minute equity and a persistent UTC baseline", async () => {
    const valuation = await refreshValuation(pool, simulationId);
    const baseline = await pool.query("SELECT equity::text FROM daily_baselines WHERE simulation_id=$1", [simulationId]);
    const history = await pool.query("SELECT count(*)::int AS count FROM equity_history WHERE simulation_id=$1", [simulationId]);
    expect(valuation.equity).toBe("10000");
    expect(baseline.rows[0].equity).toBe("10000.000000000000000000");
    expect(history.rows[0].count).toBe(1);
  });

  it("rejects valuation when a held asset has no current bid", async () => {
    await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'BTCUSDT',1,100)", [simulationId]);
    await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,101,1,1,now()-interval '10 seconds',now()-interval '10 seconds')");
    await expect(refreshValuation(pool, simulationId)).rejects.toThrow("stale quote");
  });

  it("labels the last equity as stale when its held-market quote is old", async () => {
    await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'BTCUSDT',1,100)", [simulationId]);
    await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,101,1,1,now()-interval '10 seconds',now()-interval '10 seconds')");
    await pool.query("INSERT INTO equity_history(simulation_id,cash,equity,realized_profit,unrealized_profit,observed_at) VALUES($1,10000,10100,0,0,now())", [simulationId]);
    const app = buildApp(pool, new EventHub());
    const response = await app.inject({ method: "GET", url: `/api/portfolio?simulationId=${simulationId}`, headers: { host: "127.0.0.1:3000" } });
    expect(response.json().dataStatus).toBe("stale");
    await app.close();
  });
});
