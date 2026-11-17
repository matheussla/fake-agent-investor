import type { PoolClient } from "pg";

export const DAILY_ATTEMPT_LIMIT = 300;

export async function reserveAttempt(client: PoolClient, provider: string, now = new Date()): Promise<void> {
  const utcDate = now.toISOString().slice(0, 10);
  await client.query("INSERT INTO daily_usage(utc_date,provider,attempts) VALUES($1,'all',0),($1,$2,0) ON CONFLICT(utc_date,provider) DO NOTHING", [utcDate, provider]);
  const global = await client.query("UPDATE daily_usage SET attempts=attempts+1 WHERE utc_date=$1 AND provider='all' AND attempts < $2 RETURNING attempts", [utcDate, DAILY_ATTEMPT_LIMIT]);
  if (!global.rowCount) throw new Error("Daily provider allowance exhausted");
  await client.query("UPDATE daily_usage SET attempts=attempts+1 WHERE utc_date=$1 AND provider=$2", [utcDate, provider]);
}
