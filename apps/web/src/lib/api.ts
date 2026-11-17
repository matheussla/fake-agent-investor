export interface PortfolioData { simulationId: string; cash: string; positions: Array<{ symbol: string; quantity: string; cost_basis: string }>; equity: string | null; equityObservedAt: string | null; realizedProfit: string; dataStatus: "available" | "stale" | "unavailable"; }
export interface EquityPoint { cash: string; equity: string; realized_profit: string; unrealized_profit: string; observed_at: string; }
export interface QuoteRow { symbol: string; bid: string; ask: string; bidSize: string; askSize: string; observed_at: string; }
export interface CandleRow { symbol: string; openTime: string; closeTime: string; open: string; high: string; low: string; close: string; volume: string; closed: boolean; }
export interface TradeRow { id: string; symbol: string; side: "buy" | "sell"; quantity: string; status: string; reason?: string; created_at: string; price?: string; fee?: string; }
export interface DecisionRow { id: string; request_id: string; result?: unknown; failure?: string; created_at: string; }
export interface SimulationRow { id: string; status: "active" | "archived"; starting_cash: string; created_at: string; }
export interface HealthData { database: string; market: string; provider: string; simulation: { id: string; status: string } | null; }
export interface SettingsData { version: number; values: { provider: string; model: string; assets: string[]; feeRate: string; slippageBps: number }; }

export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function simulationPath(path: string, simulationId: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}simulationId=${encodeURIComponent(simulationId)}`;
}
