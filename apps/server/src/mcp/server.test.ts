import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Pool } from "pg";
import { createAnalysisServer } from "./server.js";
import { AnalysisData } from "./data.js";

it("discovers read-only tools, guidance and recommendation prompt without database access", async () => {
  const data = new AnalysisData({ connect: () => { throw new Error("postgres://private-secret@host/db"); } } as unknown as Pool);
  const server = createAnalysisServer(data);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toEqual(["list_records", "read_record", "get_simulation_snapshot"]);
    expect(tools.every(t => t.annotations?.readOnlyHint && t.outputSchema)).toBe(true);
    const resources = (await client.listResources()).resources;
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(await client.readResource({ uri: "investor://analysis-guide" }))).toContain("untrusted");
    expect(JSON.stringify(await client.readResource({ uri: "investor://data-dictionary" }))).toContain("reports");
    expect((await client.listPrompts()).prompts).toHaveLength(1);
    expect(JSON.stringify(await client.getPrompt({ name: "suggest_agent_improvements", arguments: { simulationId: crypto.randomUUID() } }))).toContain("out-of-sample");
    const failure = await client.callTool({ name: "list_records", arguments: { dataset: "reports" } });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("private-secret");
    const invalid = await client.callTool({ name: "list_records", arguments: { dataset: "DROP TABLE" } });
    expect(invalid.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});

it("initializes and shuts down over real stdio without starting the trading app", async () => {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { fileURLToPath } = await import("node:url");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/index.ts"], cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { PATH: process.env.PATH ?? "", MCP_DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unavailable" }, stderr: "pipe" });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(3);
    const result = await client.callTool({ name: "list_records", arguments: { dataset: "simulations" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("invalid:invalid");
  } finally { await client.close(); }
});
