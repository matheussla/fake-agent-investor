import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { EventHub } from "./sse.js";

const pool = { query: vi.fn(async (statement: string) => statement === "SELECT 1" ? { rows: [] } : { rows: [] }) };

describe("local read API", () => {
  afterEach(() => vi.clearAllMocks());
  it("rejects foreign origins", async () => {
    const app = buildApp(pool as never, new EventHub());
    const response = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:3000", origin: "https://evil.example" } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
  it("returns actual database health and rejects malformed filters", async () => {
    const app = buildApp(pool as never, new EventHub());
    const headers = { host: "127.0.0.1:3000" };
    const health = await app.inject({ method: "GET", url: "/api/health", headers });
    expect(health.json()).toMatchObject({ database: "healthy", market: "unavailable" });
    const invalid = await app.inject({ method: "GET", url: "/api/prompts?limit=500", headers });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
