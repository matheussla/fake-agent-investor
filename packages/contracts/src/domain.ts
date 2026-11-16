import { z } from "zod";

export const DecimalStringSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Expected nonnegative decimal string");
export const PositiveDecimalSchema = DecimalStringSchema.refine((value) => Number(value) > 0, "Expected positive decimal string");
export const DecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("hold"), explanation: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.enum(["buy", "sell"]), symbol: z.string().regex(/^[A-Z0-9]+USDT$/), quantity: PositiveDecimalSchema, explanation: z.string().trim().min(1).max(500) }).strict(),
]);
export type Decision = z.infer<typeof DecisionSchema>;

export interface Instrument { symbol: string; baseAsset: string; quoteAsset: string; status: "trading" | "unavailable"; priceIncrement: string; quantityIncrement: string; minimumQuantity: string; minimumNotional: string; }
export interface Quote { symbol: string; bid: string; ask: string; bidSize: string; askSize: string; observedAt: string; receivedAt: string; }
export interface Candle { symbol: string; openTime: string; closeTime: string; open: string; high: string; low: string; close: string; volume: string; closed: boolean; }
export interface CandleRequest { symbol: string; startTime: string; endTime: string; interval: "1m"; }
export interface ProviderHealth { status: "healthy" | "degraded" | "unavailable"; lastMessageAt?: string; detail?: string; }
export type MarketEvent = { type: "quote"; quote: Quote } | { type: "candle"; candle: Candle } | { type: "health"; health: ProviderHealth };
export type MarketUpdate = MarketEvent | { type: "ticker"; symbol: string; priceChangePercent: string; quoteVolume: string; observedAt: string };
export type DecisionResult = { decision: Decision; usage?: { inputTokens?: number; outputTokens?: number } };
export interface DecisionInput { simulationId: string; snapshot: unknown; market: Quote[]; limits: unknown; prompt: string; promptVersion: number; configurationVersion: number; }
export interface ApprovedOrder { decisionId: string; simulationId: string; runGeneration: number; configurationVersion: number; symbol: string; side: "buy" | "sell"; quantity: string; quote: Quote; }
export interface Fill { orderId: string; symbol: string; side: "buy" | "sell"; quantity: string; price: string; fee: string; timestamp: string; }
export interface ExecutionResult { status: "filled" | "rejected"; orderId: string; reason?: string; }
export type OrderStatus = "accepted" | "rejected" | "filled" | "cancelled";
export type CancelResult = { cancelled: boolean };
export type ReconciliationResult = { consistent: boolean };
export interface PortfolioSnapshot { cash: string; positions: Array<{ symbol: string; quantity: string; costBasis: string }> }
export interface PortfolioValuation { cash: string; equity: string; realizedProfit: string; unrealizedProfit: string; totalProfit: string; }
export interface FillAccountingInput { side: "buy" | "sell"; quantity: string; price: string; fee: string; cash: string; positionQuantity: string; costBasis: string; }
export interface FillAccountingResult { cash: string; positionQuantity: string; costBasis: string; realizedProfit: string; }
export interface NewSimulationInput { startingCash: string; }
export interface Simulation { id: string; status: "active" | "archived"; }

export interface MarketDataProvider {
  instruments(signal: AbortSignal): Promise<Instrument[]>;
  quote(symbol: string, signal: AbortSignal): Promise<Quote>;
  candles(request: CandleRequest, signal: AbortSignal): Promise<Candle[]>;
  subscribe(symbols: string[], emit: (event: MarketUpdate) => void): () => void;
  health(): ProviderHealth;
}
export interface DecisionProvider { decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionResult>; }
export interface ExecutionProvider {
  submit(order: ApprovedOrder, signal: AbortSignal): Promise<ExecutionResult>;
  status(orderId: string): Promise<OrderStatus>;
  fills(orderId: string): Promise<Fill[]>;
  cancel(orderId: string): Promise<CancelResult>;
  reconcile(simulationId: string): Promise<ReconciliationResult>;
}
