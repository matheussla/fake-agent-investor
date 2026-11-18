import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { enforceDailyLoss } from "../../apps/server/src/modules/risk/daily-loss.js";
import type { MarketDataProvider } from "../../packages/contracts/src/domain.js";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { PaperExecutionProvider } from "../../apps/server/src/modules/execution/paper.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
const quote = { symbol: "BTCUSDT", bid: "100", ask: "100.1", bidSize: "3", askSize: "3", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() };
const market = { instruments: vi.fn(async () => [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "trading" as const, priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" }]), quote: vi.fn(async () => quote) } as unknown as MarketDataProvider;
let simulationId: string;
let decisionId: string;
let provider: PaperExecutionProvider;

beforeEach(async () => {
  await pool.query("TRUNCATE simulations, quote_samples CASCADE");
  simulationId = (await createSimulation(db)).id;
  await pool.query("UPDATE configurations SET values=jsonb_set(values, '{feeRate}', '\"0.001\"') WHERE simulation_id=$1", [simulationId]);
  vi.restoreAllMocks();
  vi.mocked(market.instruments).mockReset().mockResolvedValue([{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "trading", priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" }]);
  const now = new Date();
  quote.observedAt = quote.receivedAt = now.toISOString();
  quote.bid = "100"; quote.ask = "100.1"; quote.askSize = quote.bidSize = "100";
  await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,100.1,3,3,$1,$1)", [now]);
  decisionId = (await pool.query("INSERT INTO decisions(simulation_id,request_id,run_generation,configuration_version,prompt_version,input_snapshot) VALUES($1,$2,0,1,1,'{}') RETURNING id", [simulationId, crypto.randomUUID()])).rows[0].id;
  provider = new PaperExecutionProvider(pool, market);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => pool.end());

const order = () => ({ decisionId, simulationId, runGeneration: 0, configurationVersion: 1, symbol: "BTCUSDT", side: "buy" as const, quantity: "0.5", quote });

describe("atomic paper execution", () => {
  it("commits one fill and reconciles cash including a separate fee entry", async () => {
    const result = await provider.submit(order(), new AbortController().signal);
    const cash = await pool.query("SELECT sum(amount)::text AS balance FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')", [simulationId]);
    const position = await pool.query("SELECT quantity::text,cost_basis::text FROM positions WHERE simulation_id=$1", [simulationId]);
    const rows = await pool.query("SELECT (SELECT count(*)::int FROM fills WHERE simulation_id=$1) AS fills,(SELECT count(*)::int FROM ledger_entries WHERE fill_id IS NOT NULL AND kind='fee') AS fees", [simulationId]);
    expect(result.status).toBe("filled");
    expect(cash.rows[0].balance).toBe("9949.874899975000000000");
    expect(position.rows[0]).toMatchObject({ quantity: "0.500000000000000000", cost_basis: "50.125100025000000000" });
    expect(rows.rows[0]).toEqual({ fills: 1, fees: 1 });
  });

  it("allows at most one fill when the same decision is submitted concurrently", async () => {
    const results = await Promise.allSettled([provider.submit(order(), new AbortController().signal), provider.submit(order(), new AbortController().signal)]);
    const fills = await pool.query("SELECT count(*)::int AS count FROM fills WHERE simulation_id=$1", [simulationId]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(fills.rows[0].count).toBe(1);
    expect(await provider.reconcile(simulationId)).toEqual({ consistent: true });
  });
});

async function newDecision() {
  return (await pool.query("INSERT INTO decisions(simulation_id,request_id,run_generation,configuration_version,prompt_version,input_snapshot) VALUES($1,$2,0,1,1,'{}') RETURNING id", [simulationId, crypto.randomUUID()])).rows[0].id as string;
}
async function balances() {
  return (await pool.query("SELECT (SELECT sum(amount)::text FROM ledger_entries WHERE simulation_id=$1 AND asset='USDT' AND kind IN ('initial_funding','trade_cash','fee')) cash, (SELECT count(*)::int FROM fills WHERE simulation_id=$1) fills, (SELECT coalesce(sum(quantity),0)::text FROM positions WHERE simulation_id=$1) quantity, (SELECT coalesce(sum(cost_basis),0)::text FROM positions WHERE simulation_id=$1) cost, (SELECT coalesce(sum(amount),0)::text FROM ledger_entries WHERE simulation_id=$1 AND kind='realized_profit') profit", [simulationId])).rows[0];
}
function interceptQueries(after: (sql: string) => void | Promise<void>, before?: (sql: string) => void): Pool {
  return { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
      before?.(sql);
      const result = await client.query(sql, values);
      await after(sql);
      return result;
    } } as PoolClient;
  } } as unknown as Pool;
}

describe("execution retries and cancellation", () => {
  it("returns the committed result without market access, even after pause", async () => {
    const result = await provider.submit(order(), new AbortController().signal);
    await pool.query("UPDATE agent_state SET generation=generation+1,paused=true WHERE simulation_id=$1", [simulationId]);
    vi.mocked(market.instruments).mockRejectedValueOnce(new Error("Binance offline"));
    expect(await provider.submit(order(), new AbortController().signal)).toEqual(result);
    expect((await balances()).fills).toBe(1);
  });
  it("rejects reuse of a decision with a different order payload", async () => {
    await provider.submit(order(), new AbortController().signal);
    await expect(provider.submit({ ...order(), quantity: "0.6" }, new AbortController().signal)).rejects.toThrow("Idempotency conflict");
    expect((await balances()).fills).toBe(1);
  });
  it("does not execute when cancelled after metadata loading", async () => {
    const controller = new AbortController();
    const instruments = await market.instruments(controller.signal);
    vi.mocked(market.instruments).mockImplementationOnce(async () => { controller.abort(); return instruments; });
    await expect(provider.submit(order(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect((await balances()).fills).toBe(0);
  });
  it("rolls back cancellation after ledger writes and permits retry", async () => {
    const controller = new AbortController();
    const cancelling = new PaperExecutionProvider(interceptQueries((sql) => { if (sql.startsWith("INSERT INTO ledger_entries")) controller.abort(); }), market);
    await expect(cancelling.submit(order(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await balances()).toMatchObject({ cash: "10000.000000000000000000", fills: 0, quantity: "0", cost: "0" });
    expect(await provider.submit(order(), new AbortController().signal)).toMatchObject({ status: "filled" });
  });
  it("rolls back every accounting write if position persistence fails", async () => {
    const broken = new PaperExecutionProvider(interceptQueries(() => {}, (sql) => { if (sql.startsWith("INSERT INTO positions")) throw new Error("Injected position failure"); }), market);
    await expect(broken.submit(order(), new AbortController().signal)).rejects.toThrow("Injected position failure");
    expect(await balances()).toMatchObject({ cash: "10000.000000000000000000", fills: 0, quantity: "0", cost: "0" });
  });
  it("uses the fresh live quote instead of the sampled history", async () => {
    const liveMarket = { ...market, cachedQuote: () => ({ ...quote, ask: "100.2" }) };
    const result = await new PaperExecutionProvider(pool, liveMarket).submit(order(), new AbortController().signal);
    expect((await provider.fills(result.orderId))[0]?.price).toBe("100.250100000000000000");
  });
});

describe("sell accounting and concurrent trades", () => {
  it("accounts for partial and full sells including fees and realized profit", async () => {
    await provider.submit(order(), new AbortController().signal);
    await provider.submit({ ...order(), decisionId: await newDecision(), side: "sell", quantity: "0.2" }, new AbortController().signal);
    expect(await balances()).toMatchObject({ quantity: "0.300000000000000000", cost: "30.075060015000000000", profit: "-0.080030010000000000" });
    await provider.submit({ ...order(), decisionId: await newDecision(), side: "sell", quantity: "0.3" }, new AbortController().signal);
    expect(await balances()).toMatchObject({ cash: "9999.799924975000000000", quantity: "0.000000000000000000", cost: "0.000000000000000000", profit: "-0.200075025000000000" });
  });
  it("does not oversell when two different decisions compete for the same holdings", async () => {
    await provider.submit(order(), new AbortController().signal);
    const ids = await Promise.all([newDecision(), newDecision()]);
    const results = await Promise.all(ids.map((id) => provider.submit({ ...order(), decisionId: id, side: "sell", quantity: "0.4" }, new AbortController().signal)));
    expect(results.map((result) => result.status).sort()).toEqual(["filled", "rejected"]);
    expect(await balances()).toMatchObject({ fills: 2, quantity: "0.100000000000000000" });
    const rejected = results.find((result) => result.status === "rejected")!;
    const retry = await provider.submit({ ...order(), decisionId: ids[results.indexOf(rejected)]!, side: "sell", quantity: "0.4" }, new AbortController().signal);
    expect(retry).toEqual(rejected);
  });
  it("does not double-spend cash under concurrent buys", async () => {
    await pool.query(`UPDATE configurations SET values=values || '{"maximumBuyPercent":"1","maximumAssetExposure":"1","maximumTotalExposure":"1"}'::jsonb WHERE simulation_id=$1`, [simulationId]);
    await pool.query("UPDATE quote_samples SET bid_size=100,ask_size=100");
    const ids = await Promise.all([newDecision(), newDecision()]);
    const results = await Promise.all(ids.map((id) => provider.submit({ ...order(), decisionId: id, quantity: "60" }, new AbortController().signal)));
    expect(results.map((result) => result.status).sort()).toEqual(["filled", "rejected"]);
    expect(await balances()).toMatchObject({ fills: 1, quantity: "60.000000000000000000" });
    expect(Number((await balances()).cash)).toBeGreaterThanOrEqual(0);
  });
  it("does not falsely latch daily loss during a concurrent sale", async () => {
    await pool.query("UPDATE quote_samples SET bid_size=100,ask_size=100");
    await provider.submit({ ...order(), quantity: "9" }, new AbortController().signal);
    const sell = { ...order(), decisionId: await newDecision(), side: "sell" as const, quantity: "9" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let cashRead!: () => void;
    const reading = new Promise<void>((resolve) => { cashRead = resolve; });
    const valuationPool = interceptQueries(async (sql) => { if (sql.includes("sum(amount) FILTER")) { cashRead(); await gate; } });
    const valuation = enforceDailyLoss(valuationPool, simulationId);
    await reading;
    let saleFinished = false;
    const sale = provider.submit(sell, new AbortController().signal).finally(() => { saleFinished = true; });
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        expect(saleFinished || waiting.rows[0].count > 0).toBe(true);
      });
    } finally { release(); }
    await Promise.all([valuation, sale]);
    expect((await pool.query("SELECT pause_reason FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0].pause_reason).toBeNull();
    expect(await balances()).toMatchObject({ cash: "9996.398649550000000000", quantity: "0.000000000000000000" });
  });
});

describe("execution freshness and price bounds", () => {
  it("records and replays a rejection when an AI decision has expired", async () => {
    await pool.query("UPDATE decisions SET created_at=now()-interval '61 seconds' WHERE id=$1", [decisionId]);
    const result = await provider.submit(order(), new AbortController().signal);
    expect(result).toMatchObject({ status: "rejected", reason: "DECISION_EXPIRED" });
    expect(await provider.submit(order(), new AbortController().signal)).toEqual(result);
    expect((await balances()).fills).toBe(0);
  });
  it.each(["buy", "sell"] as const)("rejects adverse %s price movement beyond the configured limit", async (side) => {
    if (side === "sell") {
      await provider.submit(order(), new AbortController().signal);
      decisionId = await newDecision();
    }
    const liveMarket = { ...market, cachedQuote: () => ({ ...quote, bid: "98", ask: "102" }) };
    const result = await new PaperExecutionProvider(pool, liveMarket).submit({ ...order(), side }, new AbortController().signal);
    expect(result).toMatchObject({ status: "rejected", reason: "PRICE_MOVED" });
    expect((await balances()).fills).toBe(side === "sell" ? 1 : 0);
  });
  it("allows favorable price movement without bypassing other risk checks", async () => {
    const liveMarket = { ...market, cachedQuote: () => ({ ...quote, bid: "99", ask: "99.1" }) };
    expect(await new PaperExecutionProvider(pool, liveMarket).submit(order(), new AbortController().signal)).toMatchObject({ status: "filled" });
  });
  it("cancels safely while waiting for another transaction and can retry", async () => {
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM simulations WHERE id=$1 FOR UPDATE", [simulationId]);
    const controller = new AbortController();
    const pending = provider.submit(order(), controller.signal);
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      await vi.waitFor(async () => expect((await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].count).toBeGreaterThan(0));
      controller.abort();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    await outcome;
    expect((await balances()).fills).toBe(0);
    expect(await provider.submit(order(), new AbortController().signal)).toMatchObject({ status: "filled" });
  });
  it("bounds lock waits and rolls back so a later retry can execute", async () => {
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM simulations WHERE id=$1 FOR UPDATE", [simulationId]);
    try { await expect(provider.submit(order(), new AbortController().signal)).rejects.toMatchObject({ code: "55P03" }); }
    finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect((await balances()).fills).toBe(0);
    quote.observedAt = quote.receivedAt = new Date().toISOString();
    expect(await provider.submit(order(), new AbortController().signal)).toMatchObject({ status: "filled" });
  });
});
