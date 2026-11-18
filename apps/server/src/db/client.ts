import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export function createDatabase(url = process.env.DATABASE_URL ?? "postgres://paper:paper@127.0.0.1:5433/paper_investor") {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 5000, idleTimeoutMillis: 30_000 });
  return { pool, db: drizzle(pool, { schema }) };
}
