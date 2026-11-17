import { Decimal } from "decimal.js";

export interface RiskInput {
  action: "buy" | "sell";
  symbol: string;
  quantity: string;
  cash: string;
  positions: Array<{ symbol: string; quantity: string }>;
  bids: Record<string, string>;
  ask: string;
  bid: string;
  feeRate: string;
  slippageBps: number;
  maximumBuyPercent: string;
  maximumAssetExposure: string;
  maximumTotalExposure: string;
  dailyLossLatched?: boolean;
}
export interface RiskResult { allowed: boolean; reasonCode?: "DAILY_LOSS_PAUSE" | "INVALID_AMOUNT" | "INSUFFICIENT_CASH" | "INSUFFICIENT_POSITION" | "BUY_SIZE_LIMIT" | "ASSET_EXPOSURE_LIMIT" | "TOTAL_EXPOSURE_LIMIT" | "MISSING_PRICE"; }

export function evaluateRisk(input: RiskInput): RiskResult {
  if (input.dailyLossLatched) return { allowed: false, reasonCode: "DAILY_LOSS_PAUSE" };
  try {
    const quantity = new Decimal(input.quantity);
    const cash = new Decimal(input.cash);
    const feeRate = new Decimal(input.feeRate);
    const slip = new Decimal(input.slippageBps).div(10_000);
    const targetPrice = new Decimal(input.action === "buy" ? input.ask : input.bid).mul(input.action === "buy" ? new Decimal(1).plus(slip) : new Decimal(1).minus(slip));
    const before = new Map(input.positions.map((position) => [position.symbol, new Decimal(position.quantity)]));
    const after = new Map(before);
    const oldQuantity = before.get(input.symbol) ?? new Decimal(0);
    after.set(input.symbol, input.action === "buy" ? oldQuantity.plus(quantity) : oldQuantity.minus(quantity));
    if ([...after.values()].some((value) => !value.isFinite() || value.lt(0))) return { allowed: false, reasonCode: "INSUFFICIENT_POSITION" };
    const debitOrCredit = quantity.mul(targetPrice);
    const fee = debitOrCredit.mul(feeRate);
    const nextCash = input.action === "buy" ? cash.minus(debitOrCredit).minus(fee) : cash.plus(debitOrCredit).minus(fee);
    if (nextCash.lt(0)) return { allowed: false, reasonCode: "INSUFFICIENT_CASH" };
    const equity = cash.plus([...before].reduce((total, [symbol, held]) => total.plus(held.mul(price(input.bids[symbol]))), new Decimal(0)));
    if (!equity.isFinite() || equity.lte(0)) return { allowed: false, reasonCode: "INVALID_AMOUNT" };
    if (input.action === "buy" && debitOrCredit.plus(fee).div(equity).gt(input.maximumBuyPercent)) return { allowed: false, reasonCode: "BUY_SIZE_LIMIT" };
    const totalExposure = [...after].reduce((total, [symbol, held]) => total.plus(held.mul(price(input.bids[symbol] ?? (symbol === input.symbol ? input.bid : "")))), new Decimal(0));
    const priorExposure = [...before].reduce((total, [symbol, held]) => total.plus(held.mul(price(input.bids[symbol]))), new Decimal(0));
    if (totalExposure.div(equity).gt(input.maximumTotalExposure) && (input.action !== "sell" || totalExposure.gte(priorExposure))) return { allowed: false, reasonCode: "TOTAL_EXPOSURE_LIMIT" };
    const assetExposure = (after.get(input.symbol) ?? new Decimal(0)).mul(price(input.bids[input.symbol] ?? input.bid)).div(equity);
    const priorAssetExposure = oldQuantity.mul(price(input.bids[input.symbol] ?? input.bid)).div(equity);
    if (assetExposure.gt(input.maximumAssetExposure) && (input.action !== "sell" || assetExposure.gte(priorAssetExposure))) return { allowed: false, reasonCode: "ASSET_EXPOSURE_LIMIT" };
    return { allowed: true };
  } catch (error) {
    if (error instanceof Error && error.message === "Missing price") return { allowed: false, reasonCode: "MISSING_PRICE" };
    return { allowed: false, reasonCode: "INVALID_AMOUNT" };
  }
}

function price(value: string | undefined): Decimal {
  if (!value) throw new Error("Missing price");
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error("Invalid price");
  return parsed;
}
