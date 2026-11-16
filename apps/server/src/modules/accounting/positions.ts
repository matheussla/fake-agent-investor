import { Decimal } from "decimal.js";
import type { PortfolioSnapshot, PortfolioValuation, Quote } from "@paper-investor/contracts";
import { decimal, serialize } from "./decimal.js";

export function valuePortfolio(snapshot: PortfolioSnapshot, quotes: Quote[], startingCash = "10000", realizedProfit = "0", now = Date.now(), maxAgeMs = 5000): PortfolioValuation {
  const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const cash = decimal(snapshot.cash);
  let equity = cash;
  let cost = new Decimal(0);
  for (const position of snapshot.positions) {
    const quantity = decimal(position.quantity);
    const basis = decimal(position.costBasis);
    const quote = bySymbol.get(position.symbol);
    const age = quote ? now - Date.parse(quote.observedAt) : Infinity;
    if (!quote || !Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new Error(`Missing or stale quote for ${position.symbol}`);
    equity = equity.plus(quantity.mul(decimal(quote.bid)));
    cost = cost.plus(basis);
  }
  const unrealized = equity.minus(cash).minus(cost);
  const total = equity.minus(decimal(startingCash));
  return { cash: serialize(cash), equity: serialize(equity), realizedProfit: serialize(decimal(realizedProfit)), unrealizedProfit: serialize(unrealized), totalProfit: serialize(total) };
}
