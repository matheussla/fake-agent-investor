import type { Instrument, Quote } from "@paper-investor/contracts";
import { Decimal } from "decimal.js";
import { roundExchangeQuantity } from "../accounting/ledger.js";

export interface ValidatedPaperOrder { quantity: string; price: string; fee: string; notional: string; }

export function assertQuoteFresh(quote: Quote, now = Date.now()): void {
  const quoteAge = Math.max(now - Date.parse(quote.observedAt), now - Date.parse(quote.receivedAt));
  if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > 5000) throw new Error("Stale quote");
}

export function validatePaperOrder(input: { side: "buy" | "sell"; quantity: string; instrument: Instrument; quote: Quote; now?: number }): ValidatedPaperOrder {
  const requested = new Decimal(input.quantity);
  const quantity = new Decimal(roundExchangeQuantity(input.quantity, input.instrument.quantityIncrement));
  if (input.instrument.status !== "trading") throw new Error("Instrument unavailable");
  if (!requested.isFinite() || requested.lte(0) || !quantity.eq(requested) || quantity.lt(input.instrument.minimumQuantity)) throw new Error("Unsupported quantity increment or minimum");
  assertQuoteFresh(input.quote, input.now);
  const price = new Decimal(input.side === "buy" ? input.quote.ask : input.quote.bid)
    .mul(input.side === "buy" ? "1.0005" : "0.9995");
  const displayed = new Decimal(input.side === "buy" ? input.quote.askSize : input.quote.bidSize);
  const notional = price.mul(quantity);
  if (!price.isFinite() || price.lte(0) || !displayed.isFinite() || quantity.gt(displayed)) throw new Error("Insufficient displayed quote size");
  if (notional.lt(input.instrument.minimumNotional)) throw new Error("Below minimum notional");
  return { quantity: quantity.toFixed(), price: price.toFixed(), fee: notional.mul("0.001").toFixed(), notional: notional.toFixed() };
}
