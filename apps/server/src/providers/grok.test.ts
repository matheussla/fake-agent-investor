import { describe, expect, it, vi } from "vitest";
import type { DecisionInput } from "@paper-investor/contracts";
import { GrokDecisionProvider } from "./grok.js";

const input: DecisionInput = {
  simulationId: "simulation", snapshot: {}, market: [{ symbol: "BTCUSDT", bid: "100", ask: "101", bidSize: "2", askSize: "2", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() }],
  limits: {}, prompt: "hold", promptVersion: 1, configurationVersion: 1,
};
const hold = { action: "hold", explanation: "No trade is supported." };
const generated = (output: unknown) => vi.fn(async () => ({ output, inputTokens: 11, outputTokens: 5 }));

describe("Grok structured decision provider", () => {
  it.each([
    [{ action: "buy", symbol: "BTCUSDT", quantity: "0.01", explanation: "Within limits." }],
    [{ action: "sell", symbol: "BTCUSDT", quantity: "0.01", explanation: "Reduce exposure." }],
    [hold],
  ])("accepts valid decisions and reports usage", async (decision) => {
    const recordAttempt = vi.fn();
    const provider = new GrokDecisionProvider("secret", "grok-4.3", recordAttempt, generated(decision));
    const result = await provider.decide(input, new AbortController().signal);
    expect(result.decision).toEqual(decision);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
    expect(recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ model: "grok-4.3", outcome: "valid" }));
  });

  it.each([
    { action: "buy", symbol: "UNKNOWNUSDT", quantity: "1", explanation: "x" },
    { ...hold, extra: "field" },
    { action: "buy", symbol: "BTCUSDT", quantity: "not-a-number", explanation: "x" },
  ])("rejects untrusted invalid output", async (decision) => {
    const provider = new GrokDecisionProvider("secret", "grok-4.3", undefined, generated(decision));
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow("invalid decision");
  });

  it("does not retry quota failures and redacts provider diagnostics", async () => {
    const generator = vi.fn(async () => { throw Object.assign(new Error("secret body with token"), { statusCode: 429 }); });
    const recordAttempt = vi.fn();
    const provider = new GrokDecisionProvider("secret", "grok-4.3", recordAttempt, generator);
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow("quota unavailable");
    expect(generator).toHaveBeenCalledTimes(1);
    expect(recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "quota_rejected" }));
  });

  it("honors caller cancellation and uses the shared deadline", async () => {
    const controller = new AbortController();
    const generator = vi.fn(async ({ signal }: { model: string; input: DecisionInput; signal: AbortSignal }) => {
      expect(signal).not.toBe(controller.signal);
      expect(signal.aborted).toBe(false);
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    });
    const recordAttempt = vi.fn();
    const provider = new GrokDecisionProvider("secret", "grok-4.3", recordAttempt, generator);
    await expect(provider.decide(input, controller.signal)).rejects.toThrow("cancelled or timed out");
    expect(recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
  });

  it("reports a missing server key without exposing configuration", async () => {
    const provider = new GrokDecisionProvider(undefined, "grok-4.3");
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow("request failed");
  });
});
