import type { ApprovedOrder, Instrument, Quote } from "@paper-investor/contracts";
import { Decimal } from "decimal.js";
import { roundExchangeQuantity } from "../accounting/ledger.js";

export interface ValidatedPaperOrder { quantity: string; price: string; fee: string; notional: string; }

export function assertQuoteFresh(quote: Quote, now = Date.now()): void {
  const ages = [quote.observedAt, quote.receivedAt].map((timestamp) => now - Date.parse(timestamp));
  if (ages.some((age) => !Number.isFinite(age) || age < 0 || age > 5000)) throw new Error("Stale quote");
}

export function validatePaperOrder(input: { side: "buy" | "sell"; quantity: string; instrument: Instrument; quote: Quote; feeRate?: string; slippageBps?: number; now?: number }): ValidatedPaperOrder {
  const requested = new Decimal(input.quantity);
  const quantity = new Decimal(roundExchangeQuantity(input.quantity, input.instrument.quantityIncrement));
  if (input.instrument.status !== "trading") throw new Error("Instrument unavailable");
  if (!requested.isFinite() || requested.lte(0) || !quantity.eq(requested) || quantity.lt(input.instrument.minimumQuantity)) throw new Error("Unsupported quantity increment or minimum");
  assertQuoteFresh(input.quote, input.now);
  const slippage = new Decimal(input.slippageBps ?? 5).div(10_000);
  const price = new Decimal(input.side === "buy" ? input.quote.ask : input.quote.bid)
    .mul(input.side === "buy" ? new Decimal(1).plus(slippage) : new Decimal(1).minus(slippage));
  const displayed = new Decimal(input.side === "buy" ? input.quote.askSize : input.quote.bidSize);
  const notional = price.mul(quantity);
  if (!price.isFinite() || price.lte(0) || !displayed.isFinite() || quantity.gt(displayed)) throw new Error("Insufficient displayed quote size");
  if (notional.lt(input.instrument.minimumNotional)) throw new Error("Below minimum notional");
  return { quantity: quantity.toFixed(), price: price.toFixed(), fee: notional.mul(input.feeRate ?? "0.0035").toFixed(), notional: notional.toFixed() };
}

export function decisionMarketRejection(order: ApprovedOrder, quote: Quote, decisionCreatedAt: Date, maximumAgeSeconds: number, maximumPriceMovementBps: number, now = Date.now()): string | undefined {
  const ages = [decisionCreatedAt.getTime(), Date.parse(order.quote.observedAt), Date.parse(order.quote.receivedAt)].map((timestamp) => now - timestamp);
  if (ages.some((age) => !Number.isFinite(age) || age < 0 || age > maximumAgeSeconds * 1000)) return "DECISION_EXPIRED";
  const reference = new Decimal(order.side === "buy" ? order.quote.ask : order.quote.bid);
  if (order.quote.symbol !== order.symbol || !reference.isFinite() || reference.lte(0)) return "INVALID_REFERENCE_QUOTE";
  const price = new Decimal(order.side === "buy" ? quote.ask : quote.bid);
  const adverseMovement = order.side === "buy" ? price.minus(reference) : reference.minus(price);
  if (adverseMovement.gt(reference.mul(maximumPriceMovementBps).div(10_000))) return "PRICE_MOVED";
}
