import { describe, expect, it } from "vitest";
import { applyFillAccounting, assertAccountingIdentity, roundExchangeQuantity } from "./ledger.js";
import { valuePortfolio } from "./positions.js";

describe("decimal paper accounting", () => {
  it("includes fees in acquisition cost and reconciles partial sale profit", () => {
    const buy = applyFillAccounting({ side: "buy", quantity: "1", price: "100.05", fee: "0.10005", cash: "10000", positionQuantity: "0", costBasis: "0" });
    expect(buy).toEqual({ cash: "9899.84995", positionQuantity: "1", costBasis: "100.15005", realizedProfit: "0" });
    const sell = applyFillAccounting({ side: "sell", quantity: "0.4", price: "109.945", fee: "0.043978", cash: buy.cash, positionQuantity: buy.positionQuantity, costBasis: buy.costBasis });
    expect(sell).toEqual({ cash: "9943.783972", positionQuantity: "0.6", costBasis: "60.09003", realizedProfit: "3.874002" });
    const valuation = valuePortfolio({ cash: sell.cash, positions: [{ symbol: "BTCUSDT", quantity: sell.positionQuantity, costBasis: sell.costBasis }] }, [{ symbol: "BTCUSDT", bid: "110", ask: "110.1", bidSize: "10", askSize: "10", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString() }], "10000", sell.realizedProfit);
    expect(valuation).toMatchObject({ equity: "10009.783972", realizedProfit: "3.874002", unrealizedProfit: "5.90997", totalProfit: "9.783972" });
  });
  it("rejects oversells and cash shortfalls without mutation", () => {
    expect(() => applyFillAccounting({ side: "sell", quantity: "2", price: "1", fee: "0", cash: "0", positionQuantity: "1", costBasis: "1" })).toThrow("Insufficient holdings");
    expect(() => applyFillAccounting({ side: "buy", quantity: "1", price: "2", fee: "0", cash: "1", positionQuantity: "0", costBasis: "0" })).toThrow("Insufficient cash");
  });
  it("rounds quantities down to exchange increments", () => expect(roundExchangeQuantity("0.1239", "0.001")).toBe("0.123"));
  it("reconciles total profit to realized plus unrealized profit", () => {
    expect(assertAccountingIdentity({ startingCash: "10000", cash: "9943.783972", realizedProfit: "3.874002", positions: [{ quantity: "0.6", costBasis: "60.09003", bid: "110" }] })).toMatchObject({ equity: "10009.783972", totalProfit: "9.783972" });
    expect(() => assertAccountingIdentity({ startingCash: "10000", cash: "9943", realizedProfit: "0", positions: [{ quantity: "0.6", costBasis: "60", bid: "110" }] })).toThrow("does not reconcile");
  });
  it("does not present a stale held-asset quote as current equity", () => {
    const old = new Date(Date.now() - 5001).toISOString();
    expect(() => valuePortfolio({ cash: "0", positions: [{ symbol: "BTCUSDT", quantity: "1", costBasis: "10" }] }, [{ symbol: "BTCUSDT", bid: "10", ask: "11", bidSize: "1", askSize: "1", observedAt: old, receivedAt: old }])).toThrow("stale quote");
  });
});
