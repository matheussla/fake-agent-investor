import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../apps/server/src/db/client.js";
import { activatePrompt, savePrompt } from "../../apps/server/src/modules/prompts/service.js";
import { updateSettings } from "../../apps/server/src/modules/settings/service.js";
import { createSimulation, resetSimulation } from "../../apps/server/src/modules/simulations/service.js";

const { db, pool } = createDatabase("postgres://paper:paper@127.0.0.1:5433/paper_investor_test");
let simulationId: string;

beforeEach(async () => {
  await pool.query("TRUNCATE simulations, quote_samples, candles CASCADE");
  simulationId = (await createSimulation(db)).id;
});
afterAll(async () => pool.end());

describe("strategy versions and simulation reset", () => {
  it("keeps named prompt versions immutable and activation scoped to a name", async () => {
    const v2 = await savePrompt(db, { simulationId, name: "Default strategy", content: "version two" });
    await activatePrompt(db, v2.id);
    const rows = await pool.query("SELECT version,content,active FROM prompts WHERE simulation_id=$1 AND name='Default strategy' ORDER BY version", [simulationId]);
    expect(rows.rows).toEqual([{ version: 1, content: expect.any(String), active: false }, { version: 2, content: "version two", active: true }]);
    await expect(savePrompt(db, { simulationId, name: "", content: "x" })).rejects.toThrow();
  });

  it("requires pause and a matching version for settings; preserves held assets and balances", async () => {
    const defaults = (await pool.query("SELECT values FROM configurations WHERE simulation_id=$1", [simulationId])).rows[0].values;
    await pool.query("INSERT INTO positions(simulation_id,symbol,quantity,cost_basis) VALUES($1,'BTCUSDT',1,500)", [simulationId]);
    await pool.query("UPDATE agent_state SET paused=false WHERE simulation_id=$1", [simulationId]);
    await expect(updateSettings(db, { simulationId, expectedVersion: 1, values: { ...defaults, provider: "codex" } })).rejects.toThrow("paused");
    await pool.query("UPDATE agent_state SET paused=true WHERE simulation_id=$1", [simulationId]);
    await expect(updateSettings(db, { simulationId, expectedVersion: 1, values: { ...defaults, provider: "codex", assets: ["ETHUSDT"] } })).rejects.toThrow("position");
    const updated = await updateSettings(db, { simulationId, expectedVersion: 1, values: { ...defaults, provider: "codex" } });
    expect(updated.version).toBe(2);
    await expect(updateSettings(db, { simulationId, expectedVersion: 1, values: { ...defaults, provider: "grok" } })).rejects.toThrow("conflict");
    expect((await pool.query("SELECT quantity::text FROM positions WHERE simulation_id=$1 AND symbol='BTCUSDT'", [simulationId])).rows[0].quantity).toContain("1");
    expect((await pool.query("SELECT amount::text FROM ledger_entries WHERE simulation_id=$1 AND kind='initial_funding'", [simulationId])).rows[0].amount).toContain("10000");
  });

  it("archives evidence, invalidates the old run and makes resets idempotent", async () => {
    await pool.query("UPDATE agent_state SET generation=4,paused=false WHERE simulation_id=$1", [simulationId]);
    await pool.query("INSERT INTO operational_events(simulation_id,kind,payload) VALUES($1,'test', '{}')", [simulationId]);
    const requestId = "b42ae885-0a0a-46ce-bc1e-7a1c19835ae1";
    const fresh = await resetSimulation(db, { requestId, startingCash: "2500" });
    expect(fresh.id).not.toBe(simulationId);
    const old = await pool.query("SELECT s.status,a.paused,a.generation,count(e.id)::int AS evidence FROM simulations s JOIN agent_state a ON a.simulation_id=s.id LEFT JOIN operational_events e ON e.simulation_id=s.id WHERE s.id=$1 GROUP BY s.id,a.paused,a.generation", [simulationId]);
    expect(old.rows[0]).toMatchObject({ status: "archived", paused: true, generation: 5, evidence: 1 });
    expect(await resetSimulation(db, { requestId, startingCash: "999" })).toEqual({ id: fresh.id, status: "archived" });
    expect((await pool.query("SELECT count(*)::int AS count FROM simulations WHERE status='active'")).rows[0].count).toBe(1);
  });
});

it("validates execution freshness and price limits while preserving old configuration compatibility", async () => {
  const defaults = (await pool.query("SELECT values FROM configurations WHERE simulation_id=$1", [simulationId])).rows[0].values;
  const updated = await updateSettings(db, { simulationId, expectedVersion: 1, values: { ...defaults, maximumDecisionAgeSeconds: 30, maximumPriceMovementBps: 25 } });
  expect(updated.values).toMatchObject({ maximumDecisionAgeSeconds: 30, maximumPriceMovementBps: 25 });
  await expect(updateSettings(db, { simulationId, expectedVersion: 2, values: { ...updated.values, maximumDecisionAgeSeconds: 0 } })).rejects.toThrow("Invalid settings");
  await expect(updateSettings(db, { simulationId, expectedVersion: 2, values: { ...updated.values, maximumPriceMovementBps: 501 } })).rejects.toThrow("Invalid settings");
});
