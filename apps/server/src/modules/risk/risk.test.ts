import { describe, expect, it } from "vitest";
import { evaluateRisk } from "./evaluate.js";

const base = {
  action: "buy" as const, symbol: "BTCUSDT", quantity: "1", cash: "10000", positions: [], bids: {}, ask: "100", bid: "100",
  feeRate: "0.001", slippageBps: 0, maximumBuyPercent: "0.10", maximumAssetExposure: "0.25", maximumTotalExposure: "0.50",
};

describe("portfolio risk boundaries", () => {
  it("allows a buy at the inclusive size boundary and rejects above it including fees", () => {
    expect(evaluateRisk({ ...base, quantity: "9.99000999000999" }).allowed).toBe(true);
    expect(evaluateRisk({ ...base, quantity: "10" })).toMatchObject({ allowed: false, reasonCode: "BUY_SIZE_LIMIT" });
  });

  it("rejects projected per-asset and total exposure above their limits", () => {
    expect(evaluateRisk({ ...base, quantity: "26", maximumBuyPercent: "1" })).toMatchObject({ allowed: false, reasonCode: "ASSET_EXPOSURE_LIMIT" });
    expect(evaluateRisk({ ...base, quantity: "51", maximumBuyPercent: "1", maximumAssetExposure: "1" })).toMatchObject({ allowed: false, reasonCode: "TOTAL_EXPOSURE_LIMIT" });
  });

  it("allows risk-reducing sells above limits but enforces a daily loss latch", () => {
    const sell = { ...base, action: "sell" as const, quantity: "1", positions: [{ symbol: "BTCUSDT", quantity: "40" }], bids: { BTCUSDT: "100" }, maximumAssetExposure: "0.25", maximumTotalExposure: "0.50" };
    expect(evaluateRisk(sell).allowed).toBe(true);
    expect(evaluateRisk({ ...sell, dailyLossLatched: true })).toMatchObject({ allowed: false, reasonCode: "DAILY_LOSS_PAUSE" });
  });

  it("rejects invalid amounts and missing held-asset prices", () => {
    expect(evaluateRisk({ ...base, quantity: "-1" }).allowed).toBe(false);
    expect(evaluateRisk({ ...base, positions: [{ symbol: "ETHUSDT", quantity: "1" }] })).toMatchObject({ allowed: false, reasonCode: "MISSING_PRICE" });
  });
});
