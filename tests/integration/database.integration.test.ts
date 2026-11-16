import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { createSimulation } from "../../apps/server/src/modules/simulations/service.js";

const connection = process.env.TEST_DATABASE_URL ?? "postgres://paper:paper@127.0.0.1:5433/paper_investor_test";
if (!new URL(connection).pathname.endsWith("/paper_investor_test")) throw new Error("Integration tests require isolated paper_investor_test database");
const { db, pool } = createDatabase(connection);

beforeEach(async () => {
  await pool.query("TRUNCATE simulations CASCADE");
});
afterAll(async () => pool.end());

describe("PostgreSQL persistence", () => {
  it("creates one paused, funded portfolio with versioned defaults atomically", async () => {
    const simulation = await createSimulation(db);
    const simulationId = simulation.id;
    const funding = await pool.query("SELECT asset, amount::text, kind FROM ledger_entries WHERE simulation_id = $1", [simulationId]);
    const configuration = await pool.query("SELECT version FROM configurations WHERE simulation_id = $1", [simulationId]);
    expect(funding.rows[0]).toMatchObject({ asset: "USDT", amount: "10000.000000000000000000", kind: "initial_funding" });
    expect(configuration.rows[0]?.version).toBe(1);
  });

  it("enforces the single-active-simulation invariant in PostgreSQL", async () => {
    await createSimulation(db);
    await expect(createSimulation(db)).rejects.toThrow();
    const activeCount = await pool.query("SELECT count(*)::int AS value FROM simulations WHERE status = 'active'");
    expect(activeCount.rows[0]?.value).toBe(1);
  });
});
