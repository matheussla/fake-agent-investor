import { afterEach, expect, it, vi } from "vitest";
import type { AgentTurnInput } from "@paper-investor/contracts";
import { TradingTeamProvider } from "./team.js";

const agent = { id: "64da7e04-85d3-4855-bf18-93ec7f570a4e", simulationId: "simulation", name: "Lead", enabled: true, isLead: true, archived: false, prompt: "Assess risk.", promptVersion: 1, status: "ready" };
const input: AgentTurnInput = { agent, roster: [agent], context: { simulationId: "simulation", snapshot: {}, market: [], limits: { provider: "codex", model: "gpt-5.3-codex" }, prompt: "Assess risk.", promptVersion: 1, configurationVersion: 1 }, history: [], messages: ["Assess"], finalize: true, kind: "trading" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("supports OpenAI team turns with strict compatible output and no tools", async () => {
  const output = { message: "No edge", handoffs: [], decision: { action: "hold", explanation: "Wait." } };
  let requestBody = "";
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    requestBody = options.body;
    return Response.json({ id: "resp_test", created_at: 1, model: "gpt-5.3-codex", status: "completed", output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } });
  }));
  vi.stubEnv("OPENAI_API_KEY", "test-secret");
  expect(await new TradingTeamProvider().turn(input, new AbortController().signal)).toEqual(output);
  const body = JSON.parse(requestBody);
  expect(body.store).toBe(false);
  expect(body.model).toBe("gpt-5.3-codex");
  expect(JSON.stringify(body.text.format.schema)).not.toContain('"oneOf"');
  expect(body.tools ?? []).toEqual([]);
});
it("rejects missing OpenAI credentials before any request", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(new TradingTeamProvider().turn(input, new AbortController().signal)).rejects.toThrow("Codex provider unavailable");
  expect(fetch).not.toHaveBeenCalled();
});
