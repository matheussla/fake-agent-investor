import { describe, expect, it } from "vitest";
import { DecisionSchema, DecimalStringSchema } from "./domain.js";

describe("shared domain contracts", () => {
  it("accepts exact decimal strings but rejects malformed and signed amounts", () => {
    expect(DecimalStringSchema.parse("100.005")).toBe("100.005");
    for (const value of ["NaN", "Infinity", "-1", "1e3", "01"]) expect(DecimalStringSchema.safeParse(value).success).toBe(false);
  });
  it("validates buy, sell, and hold decisions and rejects extra fields", () => {
    expect(DecisionSchema.safeParse({ action: "buy", symbol: "BTCUSDT", quantity: "0.25", explanation: "within limit" }).success).toBe(true);
    expect(DecisionSchema.safeParse({ action: "hold", explanation: "wait" }).success).toBe(true);
    expect(DecisionSchema.safeParse({ action: "buy", symbol: "BTCUSDT", quantity: "0", explanation: "no", sql: "DELETE" }).success).toBe(false);
  });
});
