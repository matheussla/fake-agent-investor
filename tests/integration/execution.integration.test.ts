import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  await pool.query("TRUNCATE simulations CASCADE");
  simulationId = (await createSimulation(db)).id;
  decisionId = (await pool.query("INSERT INTO decisions(simulation_id,request_id,run_generation,configuration_version,prompt_version,input_snapshot) VALUES($1,$2,0,1,1,'{}') RETURNING id", [simulationId, crypto.randomUUID()])).rows[0].id;
  provider = new PaperExecutionProvider(pool, market);
});
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
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fills.rows[0].count).toBe(1);
    expect(await provider.reconcile(simulationId)).toEqual({ consistent: true });
  });
});
