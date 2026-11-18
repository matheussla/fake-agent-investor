import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { latestQuotes } from "./latest-quotes.js";

describe("latest quote lookup", () => {
  it("returns decimal strings and ISO timestamps from database rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ symbol: "BTCUSDT", bid: "100.01", ask: "100.02", bidSize: "2", askSize: "3", observedAt: new Date("2026-11-18T03:00:00Z"), receivedAt: new Date("2026-11-18T03:00:01Z") }] });
    const database = { query } as unknown as PoolClient;
    await expect(latestQuotes(database, ["BTCUSDT", "BTCUSDT", "ETHUSDT"])).resolves.toEqual([
      { symbol: "BTCUSDT", bid: "100.01", ask: "100.02", bidSize: "2", askSize: "3", observedAt: "2026-11-18T03:00:00.000Z", receivedAt: "2026-11-18T03:00:01.000Z" },
    ]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [["BTCUSDT", "ETHUSDT"]]);
  });

  it("does not query the database for an empty symbol list", async () => {
    const query = vi.fn();
    await expect(latestQuotes({ query } as unknown as Pool, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates database failures", async () => {
    const query = vi.fn().mockRejectedValue(new Error("Database unavailable"));
    await expect(latestQuotes({ query } as unknown as Pool, ["BTCUSDT"])).rejects.toThrow("Database unavailable");
  });
});
