import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";
import { buildDecisionInput } from "../../apps/server/src/modules/decisions/context.js";
const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;
beforeEach(async () => { await pool.query("TRUNCATE simulations,candles CASCADE"); simulationId = (await createSimulation(db)).id; });
afterAll(() => pool.end());
it("supplies bounded chronological closed candles only for configured assets, without future data", async () => {
  await pool.query(`INSERT INTO candles(symbol,open_time,close_time,open,high,low,close,volume,closed)
    SELECT symbol, now()-n*interval '1 minute',now()-(n-1)*interval '1 minute',100,102,99,101,10, n<>2
    FROM generate_series(-1,70) n CROSS JOIN unnest(ARRAY['BTCUSDT','ETHUSDT','DOGEUSDT']) symbol`);
  const input = await buildDecisionInput(pool, simulationId);
  const candles = (input as unknown as { candles: Array<{ symbol: string; closeTime: string; closed: boolean; close: string }> }).candles;
  expect(candles).toHaveLength(120);
  expect(new Set(candles.map((c) => c.symbol))).toEqual(new Set(["BTCUSDT", "ETHUSDT"]));
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const history = candles.filter((c) => c.symbol === symbol);
    expect(history).toHaveLength(60);
    expect(history.every((c) => c.closed && Date.parse(c.closeTime) <= Date.parse(input.capturedAt!) && typeof c.close === "string")).toBe(true);
    expect(history.map((c) => c.closeTime)).toEqual(history.map((c) => c.closeTime).sort());
  }
});
it("leaves unavailable history empty without inventing market evidence", async () => {
  expect(await buildDecisionInput(pool, simulationId)).toMatchObject({ candles: [] });
});
