import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { EventHub } from "./sse.js";

const pool = { query: vi.fn(async (statement: string) => statement === "SELECT 1" ? { rows: [] } : { rows: [] }) };

describe("local read API", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
  it.each(["", "openai_test_secret_must_not_leave_server"])("reports Codex credential readiness without exposing the key", async (key) => {
    vi.stubEnv("OPENAI_API_KEY", key);
    const app = buildApp(pool as never, new EventHub());
    const health = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:3000" } });
    expect(health.json().providers.codex).toBe(key ? "configured" : "missing_credentials");
    expect(health.body).not.toContain("openai_test_secret_must_not_leave_server");
    await app.close();
  });
  it("rejects foreign origins", async () => {
    const app = buildApp(pool as never, new EventHub());
    const response = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:3000", origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
  it("returns actual database health and rejects malformed filters", async () => {
    const app = buildApp(pool as never, new EventHub());
    const headers = { host: "127.0.0.1:3000" };
    vi.stubEnv("XAI_API_KEY", "xai_test_secret_must_not_leave_server");
    vi.stubEnv("OPENAI_API_KEY", "");
    const health = await app.inject({ method: "GET", url: "/api/health", headers });
    expect(health.json()).toMatchObject({ database: "healthy", market: "unavailable", providers: { grok: "configured", codex: "missing_credentials" } });
    expect(health.body).not.toContain("xai_test_secret_must_not_leave_server");
    const invalid = await app.inject({ method: "GET", url: "/api/prompts?limit=500", headers });
    expect(invalid.statusCode).toBe(400);
    const invalidCandle = await app.inject({ method: "GET", url: "/api/candles?symbol=BAD", headers });
    expect(invalidCandle.statusCode).toBe(400);
    await app.close();
  });
  it("keeps market health degraded while any configured symbol lacks fresh data", () => {
    const events = new EventHub();
    events.publishMarket({ type: "health", health: { status: "healthy" } });
    events.publishMarket({ type: "health", health: { status: "degraded", symbol: "BTCUSDT" } });
    events.publishMarket({ type: "health", health: { status: "healthy", symbol: "ETHUSDT" } });
    expect(events.health()).toBe("degraded");
  });
});
