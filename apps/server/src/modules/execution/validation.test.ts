import { describe, expect, it } from "vitest";
import type { Instrument, Quote } from "@paper-investor/contracts";
import { assertQuoteFresh, validatePaperOrder } from "./validation.js";

const instrument: Instrument = { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "trading", priceIncrement: "0.01", quantityIncrement: "0.001", minimumQuantity: "0.001", minimumNotional: "5" };
const quote: Quote = { symbol: "BTCUSDT", bid: "100", ask: "100.1", bidSize: "2", askSize: "1", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() };

describe("paper order validation", () => {
  it("applies five basis points of buy slippage and a 0.1 percent fee", () => expect(validatePaperOrder({ side: "buy", quantity: "0.5", instrument, quote }).price).toBe("100.15005"));
  it.each(["0.5001", "3"])("rejects unsupported or oversized quantity %s", (quantity) => expect(() => validatePaperOrder({ side: "buy", quantity, instrument, quote })).toThrow());
  it("rejects stale quotes and below-minimum orders", () => {
    expect(() => validatePaperOrder({ side: "buy", quantity: "0.5", instrument, quote, now: Date.parse(quote.receivedAt) + 5001 })).toThrow("Stale quote");
    expect(() => validatePaperOrder({ side: "buy", quantity: "0.001", instrument, quote })).toThrow("Below minimum notional");
  });
  it("rejects a quote that becomes stale while waiting for a transaction lock", () => {
    const receipt = Date.parse(quote.receivedAt);
    expect(() => assertQuoteFresh(quote, receipt + 5001)).toThrow("Stale quote");
  });
});
