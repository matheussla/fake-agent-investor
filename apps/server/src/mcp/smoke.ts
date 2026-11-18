import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listOutputSchema, recordOutputSchema } from "./data.js";

const client = new Client({ name: "paper-investor-mcp-smoke", version: "1.0.0" });
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !/API_KEY/.test(entry[0])));
const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/index.ts"], cwd: fileURLToPath(new URL("../../", import.meta.url)), env: environment, stderr: "pipe" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 3);
  assert(tools.every(tool => tool.annotations?.readOnlyHint));
  assert.equal((await client.listResources()).resources.length, 2);
  await client.readResource({ uri: "investor://analysis-guide" });
  await client.readResource({ uri: "investor://data-dictionary" });
  const result = await client.callTool({ name: "list_records", arguments: { dataset: "simulations", limit: 1 } });
  assert(!result.isError, "Database read failed");
  const page = listOutputSchema.parse(result.structuredContent);
  if (page.records.length) {
    const id = page.records[0].id as string;
    const record = await client.callTool({ name: "read_record", arguments: { dataset: "simulations", id } });
    assert(!record.isError);
    assert.equal(JSON.parse(recordOutputSchema.parse(record.structuredContent).jsonChunk).id, id);
    assert(!(await client.callTool({ name: "get_simulation_snapshot", arguments: { simulationId: id } })).isError);
    await client.getPrompt({ name: "suggest_agent_improvements", arguments: { simulationId: id } });
    const reports = await client.callTool({ name: "list_records", arguments: { dataset: "reports", simulationId: id, limit: 1 } });
    assert(!reports.isError);
    const reportPage = listOutputSchema.parse(reports.structuredContent);
    if (reportPage.records.length) {
      const report = await client.callTool({ name: "read_record", arguments: { dataset: "reports", id: reportPage.records[0].id } });
      assert(!report.isError);
      recordOutputSchema.parse(report.structuredContent);
    }
  }
  process.stdout.write(`MCP smoke passed: ${tools.length} read-only tools, 2 resources, database reads verified. No model calls or mutations.\n`);
} catch {
  process.stderr.write("MCP smoke failed. Check database availability, migrations and local dependencies.\n");
  process.exitCode = 1;
} finally { await client.close(); }
