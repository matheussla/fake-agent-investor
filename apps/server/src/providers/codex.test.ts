import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionInput } from "@paper-investor/contracts";
import { CodexDecisionProvider } from "./codex.js";

const input: DecisionInput = {
  simulationId: "simulation", snapshot: {}, market: [{ symbol: "BTCUSDT", bid: "100", ask: "101", bidSize: "2", askSize: "2", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() }],
  limits: {}, prompt: "Hold unless evidence supports a trade.", promptVersion: 1, configurationVersion: 1,
};
const hold = { action: "hold", explanation: "No trade is supported." };

function mockResponse(decision: unknown) {
  const fetch = vi.fn(async () => Response.json({
    id: "resp_test", created_at: 1, model: "gpt-5.3-codex", status: "completed",
    output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ decision }), annotations: [] }] }],
    usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Codex API decision provider", () => {
  it.each([hold, { action: "buy", symbol: "BTCUSDT", quantity: "0.01", explanation: "Within limits." }, { action: "sell", symbol: "BTCUSDT", quantity: "0.01", explanation: "Reduce exposure." }])("validates decisions and captures token usage", async (decision) => {
    const fetch = mockResponse(decision);
    const result = await new CodexDecisionProvider("test-secret").decide(input, new AbortController().signal);
    expect(result).toEqual({ decision, usage: { inputTokens: 11, outputTokens: 5 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-secret");
    const body = JSON.parse(options.body as string);
    expect(body).toMatchObject({ model: "gpt-5.3-codex", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(body.text.format.schema.properties.decision.anyOf).toHaveLength(2);
    expect(JSON.stringify(body.text.format.schema)).not.toContain('"oneOf"');
    expect(body.tools ?? []).toEqual([]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the model from the simulation settings", async () => {
    const fetch = mockResponse(hold);
    await new CodexDecisionProvider("test-secret").decide({ ...input, limits: { model: "gpt-5.3-codex-2026-02-24" } }, new AbortController().signal);
    const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string).model).toBe("gpt-5.3-codex-2026-02-24");
  });

  it.each([
    { ...hold, extra: "field" },
    { action: "buy", symbol: "UNKNOWNUSDT", quantity: "1", explanation: "Unknown asset." },
    { action: "buy", symbol: "BTCUSDT", quantity: "0", explanation: "Zero size." },
  ])("rejects invalid or unavailable-asset decisions", async (decision) => {
    mockResponse(decision);
    await expect(new CodexDecisionProvider("test-secret").decide(input, new AbortController().signal)).rejects.toThrow("invalid decision");
  });

  it.each([[401, "authentication failed"], [429, "quota unavailable"], [500, "request failed"]])("redacts HTTP %s errors without retrying", async (status, message) => {
    const fetch = vi.fn(async () => Response.json({ error: { message: "private test-secret response", type: "api_error", code: "test_error", param: null } }, { status: Number(status) }));
    vi.stubGlobal("fetch", fetch);
    const request = new CodexDecisionProvider("test-secret").decide(input, new AbortController().signal);
    await expect(request).rejects.toThrow(String(message));
    await expect(request).rejects.not.toThrow("test-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects missing credentials and pre-cancelled requests without calling the API", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetch = mockResponse(hold);
    await expect(new CodexDecisionProvider().decide(input, new AbortController().signal)).rejects.toThrow("OPENAI_API_KEY");
    await expect(new CodexDecisionProvider("test-secret").decide(input, AbortSignal.abort())).rejects.toThrow("cancelled or timed out");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      controller.abort();
      options.signal?.throwIfAborted();
      return Response.json({});
    }));
    await expect(new CodexDecisionProvider("test-secret").decide(input, controller.signal)).rejects.toThrow("cancelled or timed out");
  });
});
