import type { Pool, PoolClient } from "pg";

interface LockedSimulation { status: string; startingCash: string; }

export async function withSimulationTransaction<T>(pool: Pool, simulationId: string, work: (client: PoolClient, simulation: LockedSimulation) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const client = await pool.connect();
  let started = false;
  try {
    signal?.throwIfAborted();
    await client.query("BEGIN");
    started = true;
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='5s'");
    const simulation = await client.query<LockedSimulation>('SELECT status,starting_cash::text AS "startingCash" FROM simulations WHERE id=$1 FOR UPDATE', [simulationId]);
    signal?.throwIfAborted();
    if (!simulation.rows[0]) throw new Error("Simulation not found");
    const result = await work(client, simulation.rows[0]);
    signal?.throwIfAborted();
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
