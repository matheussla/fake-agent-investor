import { Pool } from "pg";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnalysisData } from "./data.js";
import { createAnalysisServer } from "./server.js";

// Independent entry point: never import the application, trading runtime or provider clients.
const pool = new Pool({
  connectionString: process.env.MCP_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://paper:paper@127.0.0.1:5433/paper_investor",
  max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, idleTimeoutMillis: 1000,
  options: "-c default_transaction_read_only=on -c timezone=UTC",
});
pool.on("error", () => { process.stderr.write("MCP database connection became unavailable.\n"); });
const server = createAnalysisServer(new AnalysisData(pool));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await server.close(); await pool.end(); }
  catch { process.stderr.write("MCP shutdown failed.\n"); process.exitCode = 1; }
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.stdin.once("end", () => { void shutdown(); });
try { await server.connect(new StdioServerTransport()); }
catch { process.stderr.write("MCP startup failed.\n"); process.exitCode = 1; await shutdown(); }
