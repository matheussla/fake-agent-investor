import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { enforceDailyLoss } from "../../apps/server/src/modules/risk/daily-loss.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;

beforeEach(async () => {
  await pool.query("TRUNCATE simulations CASCADE");
  simulationId = (await createSimulation(db)).id;
});
afterAll(async () => pool.end());

describe("daily loss latch", () => {
  it("pauses at the 5% boundary and stays paused after valuation recovers", async () => {
    const now = new Date();
    await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'BTCUSDT',1,100)", [simulationId]);
    await pool.query("INSERT INTO ledger_entries(simulation_id,asset,amount,kind) VALUES($1,'USDT',-600,'trade_cash')", [simulationId]);
    await pool.query("INSERT INTO daily_baselines(simulation_id,utc_date,equity,observed_at) VALUES($1,$2,10000,$3)", [simulationId, now.toISOString().slice(0, 10), now]);
    await pool.query("INSERT INTO quote_samples(symbol,bid,ask,bid_size,ask_size,observed_at,received_at) VALUES('BTCUSDT',100,101,5,5,$1,$1)", [now]);
    await enforceDailyLoss(pool, simulationId, now);
    expect((await pool.query("SELECT paused,pause_reason,generation FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, pause_reason: "daily_loss_limit", generation: 1 });
    await pool.query("UPDATE quote_samples SET bid=200,ask=201");
    await enforceDailyLoss(pool, simulationId, now);
    expect((await pool.query("SELECT paused,pause_reason,generation FROM agent_state WHERE simulation_id=$1", [simulationId])).rows[0]).toMatchObject({ paused: true, pause_reason: "daily_loss_limit", generation: 1 });
  });
});
