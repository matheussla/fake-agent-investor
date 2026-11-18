import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { persistMarketUpdate, pruneMarketHistory } from "../../apps/server/src/modules/market/retention.js";
import { refreshValuation } from "../../apps/server/src/modules/portfolio/valuation.js";
import { enforceDailyLoss } from "../../apps/server/src/modules/risk/daily-loss.js";
import { latestQuotes } from "../../apps/server/src/modules/market/latest-quotes.js";
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

it.each([refreshValuation, enforceDailyLoss])("uses current quote time after waiting for the portfolio lock (%#)", async (refresh) => {
  await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'BTCUSDT',1,100)", [simulationId]);
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM simulations WHERE id=$1 FOR UPDATE", [simulationId]);
  const pending = refresh(pool, simulationId);
  const outcome = expect(pending).resolves.not.toThrow();
  try {
    await vi.waitFor(async () => expect((await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].count).toBeGreaterThan(0));
    await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,101,1,1,clock_timestamp(),clock_timestamp())");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  await outcome;
});

it("selects one latest received quote per requested symbol without losing decimal precision", async () => {
  await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,101,1,1,now()-interval '3 seconds',now()-interval '2 seconds'),('BTCUSDT',100.123456789123456789,101,2,3,now()-interval '2 seconds',now()-interval '1 second'),('ETHUSDT',50,51,4,5,now(),now())");
  const quotes = await latestQuotes(pool, ["BTCUSDT", "ETHUSDT", "BTCUSDT", "MISSINGUSDT"]);
  expect(quotes).toHaveLength(2);
  expect(quotes.find((quote) => quote.symbol === "BTCUSDT")?.bid).toBe("100.123456789123456789");
  expect(quotes.find((quote) => quote.symbol === "ETHUSDT")?.bid).toBe("50.000000000000000000");
});

it("paginates market quotes by observation time and omits markets outside the simulation", async () => {
  await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',99,100,1,1,now()-interval '10 seconds',now()-interval '10 seconds'),('BTCUSDT',100,101,1,1,now(),now()),('NOTCONFIGUREDUSDT',1,2,1,1,now(),now())");
  const app = buildApp(pool, new EventHub());
  try {
    const current = await app.inject({ method: "GET", url: `/api/markets?simulationId=${simulationId}`, headers: { host: "127.0.0.1:3000" } });
    expect(current.json().map((quote: { symbol: string }) => quote.symbol)).toEqual(["BTCUSDT"]);
    expect(current.json()[0].bid).toBe("100.000000000000000000");
    const before = encodeURIComponent(new Date(Date.now() - 5000).toISOString());
    const historical = await app.inject({ method: "GET", url: `/api/markets?simulationId=${simulationId}&before=${before}`, headers: { host: "127.0.0.1:3000" } });
    expect(historical.json()[0].bid).toBe("99.000000000000000000");
  } finally { await app.close(); }
});
