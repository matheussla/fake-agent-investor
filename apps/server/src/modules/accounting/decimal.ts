import { Decimal } from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export function decimal(value: string): Decimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("Invalid decimal amount");
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error("Invalid decimal amount");
  return result;
}

export function serialize(value: Decimal): string {
  if (!value.isFinite()) throw new Error("Non-finite amount");
  return value.isZero() ? "0" : value.toFixed();
}
