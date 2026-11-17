import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { EventHub } from "./sse.js";

const pool = { query: vi.fn(async (query: string) => query.includes("FROM simulations WHERE status='active'") ? { rows: [{ id: "65a913ab-2af7-46d9-90f1-5a1c198b315f" }] } : { rows: [] }) };
const agent = { startAgent: vi.fn(async () => ({ simulationId: "sim", paused: false, generation: 0, pauseReason: null })), pauseAgent: vi.fn(async () => ({ simulationId: "sim", paused: true, generation: 1, pauseReason: "manual" })), enqueueRunOnce: vi.fn(async (requestId: string) => ({ id: "decision", simulationId: "sim", requestId, status: "pending" })) };
const headers = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const withoutOrigin = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "origin"));

describe("local control API protection", () => {
  afterEach(() => vi.clearAllMocks());

  it("allows same-origin read requests when control routes are registered", async () => {
    const app = buildApp(pool as never, new EventHub(), { db: {} as never, agent: agent as never });
    const response = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    [withoutOrigin],
    [{ ...headers, origin: "null" }],
    [{ ...headers, origin: "https://attacker.example" }],
    [{ ...headers, host: "attacker.example" }],
    [{ ...headers, "sec-fetch-site": "cross-site" }],
    [{ ...headers, "content-type": "text/plain" }],
  ])("rejects unsafe mutation metadata", async (unsafeHeaders) => {
    const app = buildApp(pool as never, new EventHub(), { db: {} as never, agent: agent as never });
    const response = await app.inject({ method: "POST", url: "/api/agent/start", headers: unsafeHeaders, payload: {} });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects malformed JSON schemas and accepts validated lifecycle requests", async () => {
    const app = buildApp(pool as never, new EventHub(), { db: {} as never, agent: agent as never });
    const invalid = await app.inject({ method: "POST", url: "/api/agent/run-once", headers, payload: { requestId: "bad" } });
    expect(invalid.statusCode).toBe(400);
    const started = await app.inject({ method: "POST", url: "/api/agent/start", headers, payload: {} });
    expect(started.statusCode).toBe(200);
    const accepted = await app.inject({ method: "POST", url: "/api/agent/run-once", headers, payload: { requestId: "f0dc3f62-0a99-4d45-9eac-03d9b1b40001" } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ status: "pending" });
    expect(agent.enqueueRunOnce).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
