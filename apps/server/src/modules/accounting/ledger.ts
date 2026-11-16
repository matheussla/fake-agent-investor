import { Decimal } from "decimal.js";
import type { FillAccountingInput, FillAccountingResult } from "@paper-investor/contracts";
import { decimal, serialize } from "./decimal.js";

export function applyFillAccounting(input: FillAccountingInput): FillAccountingResult {
  const quantity = decimal(input.quantity);
  const price = decimal(input.price);
  const fee = decimal(input.fee);
  const cash = decimal(input.cash);
  const oldQuantity = decimal(input.positionQuantity);
  const oldCost = decimal(input.costBasis);
  if (quantity.lte(0) || price.lte(0) || fee.lt(0) || cash.lt(0) || oldQuantity.lt(0) || oldCost.lt(0)) throw new Error("Invalid fill accounting input");
  const gross = quantity.mul(price);
  if (input.side === "buy") {
    const debit = gross.plus(fee);
    if (debit.gt(cash)) throw new Error("Insufficient cash");
    return { cash: serialize(cash.minus(debit)), positionQuantity: serialize(oldQuantity.plus(quantity)), costBasis: serialize(oldCost.plus(debit)), realizedProfit: "0" };
  }
  if (quantity.gt(oldQuantity)) throw new Error("Insufficient holdings");
  const proceeds = gross.minus(fee);
  const soldCost = oldCost.mul(quantity).div(oldQuantity);
  const remainingQuantity = oldQuantity.minus(quantity);
  const remainingCost = remainingQuantity.isZero() ? new Decimal(0) : oldCost.minus(soldCost);
  return { cash: serialize(cash.plus(proceeds)), positionQuantity: serialize(remainingQuantity), costBasis: serialize(remainingCost), realizedProfit: serialize(proceeds.minus(soldCost)) };
}

export function roundExchangeQuantity(quantity: string, increment: string): string {
  const q = decimal(quantity); const step = decimal(increment);
  if (q.lt(0) || step.lte(0)) throw new Error("Invalid exchange quantity");
  const units = q.div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return serialize(units.mul(step));
}

export function assertAccountingIdentity(input: { startingCash: string; cash: string; positions: Array<{ quantity: string; costBasis: string; bid: string }>; realizedProfit: string }) {
  const equity = decimal(input.cash).plus(input.positions.reduce((sum, position) => sum.plus(decimal(position.quantity).mul(decimal(position.bid))), new Decimal(0)));
  const unrealized = input.positions.reduce((sum, position) => sum.plus(decimal(position.quantity).mul(decimal(position.bid)).minus(decimal(position.costBasis))), new Decimal(0));
  const total = equity.minus(decimal(input.startingCash));
  const realized = decimal(input.realizedProfit);
  if (!total.eq(realized.plus(unrealized))) throw new Error("Portfolio accounting does not reconcile");
  return { equity: serialize(equity), realizedProfit: serialize(realized), unrealizedProfit: serialize(unrealized), totalProfit: serialize(total) };
}
