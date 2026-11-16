import { Decimal } from "decimal.js";

export function sellPerformance(realizedProfits: string[]) {
  if (realizedProfits.length === 0) return { winRate: null, averageRealizedProfit: null, basis: "sell executions" as const };
  const profits = realizedProfits.map((value) => new Decimal(value));
  const wins = profits.filter((value) => value.gt(0)).length;
  const average = profits.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(profits.length);
  return { winRate: new Decimal(wins).div(profits.length).mul(100).toFixed(), averageRealizedProfit: average.toFixed(), basis: "sell executions" as const };
}
