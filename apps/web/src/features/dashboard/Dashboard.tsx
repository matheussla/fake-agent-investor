import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, simulationPath, type CandleRow, type DecisionRow, type EquityPoint, type HealthData, type PortfolioData, type PromptRow, type QuoteRow, type SettingsData, type SimulationRow, type TradeRow } from "../../lib/api.js";
import { connectLiveEvents } from "../../lib/events.js";
import { Activity } from "./Activity.js";
import { EquityChart } from "./EquityChart.js";
import { Health } from "./Health.js";
import { History } from "./History.js";
import { MarketChart } from "./MarketChart.js";
import { Positions } from "./Positions.js";
import { Controls } from "../agent/Controls.js";
import { PromptEditor } from "../prompts/PromptEditor.js";
import { Settings } from "../settings/Settings.js";
import { ResetDialog } from "../simulations/ResetDialog.js";

interface DashboardData { simulations: SimulationRow[]; portfolio: PortfolioData | null; equity: EquityPoint[]; markets: QuoteRow[]; candles: CandleRow[]; trades: TradeRow[]; decisions: DecisionRow[]; prompts: PromptRow[]; health: HealthData | null; settings: SettingsData | null; }
const emptyData: DashboardData = { simulations: [], portfolio: null, equity: [], markets: [], candles: [], trades: [], decisions: [], prompts: [], health: null, settings: null };

export function Dashboard() {
  const [data, setData] = useState(emptyData);
  const [simulationId, setSimulationId] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (requestedSimulation = simulationId) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const simulations = await api<SimulationRow[]>("/api/simulations", controller.signal);
      const currentId = requestedSimulation || simulations.find((item) => item.status === "active")?.id || simulations[0]?.id || "";
      if (!currentId) {
        setData({ ...emptyData, simulations }); setSimulationId(""); setUpdatedAt(new Date()); setError(""); return;
      }
      const paths = ["/api/portfolio", "/api/equity", "/api/markets", "/api/trades", "/api/decisions", "/api/health", "/api/settings"] as const;
      const [portfolio, equity, markets, trades, decisions, prompts, health, settings] = await Promise.all([
        api<PortfolioData>(simulationPath(paths[0], currentId), controller.signal),
        api<EquityPoint[]>(simulationPath(paths[1], currentId), controller.signal),
        api<QuoteRow[]>(simulationPath(paths[2], currentId), controller.signal),
        api<TradeRow[]>(simulationPath(paths[3], currentId), controller.signal),
        api<DecisionRow[]>(simulationPath(paths[4], currentId), controller.signal),
        api<PromptRow[]>(simulationPath("/api/prompts", currentId), controller.signal),
        api<HealthData>(paths[5], controller.signal),
        api<SettingsData | null>(paths[6], controller.signal),
      ]);
      const symbols = settings?.values.assets ?? ["BTCUSDT"];
      const symbol = symbols.includes(selectedSymbol) ? selectedSymbol : symbols[0] ?? "BTCUSDT";
      const candles = await api<CandleRow[]>(`/api/candles?symbol=${encodeURIComponent(symbol)}`, controller.signal);
      setData({ simulations, portfolio, equity: [...equity].reverse(), markets, trades, decisions, prompts, health, settings, candles });
      setSimulationId(currentId); setSelectedSymbol(symbol); setUpdatedAt(new Date()); setError("");
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load dashboard data");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [simulationId, selectedSymbol]);

  const queueRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; void refresh(); }, 1000);
  }, [refresh]);

  useEffect(() => { void refresh(); return () => { abortRef.current?.abort(); if (refreshTimer.current) clearTimeout(refreshTimer.current); }; }, [refresh]);
  useEffect(() => {
    const disconnect = connectLiveEvents(queueRefresh);
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => { disconnect(); document.removeEventListener("visibilitychange", onFocus); window.removeEventListener("focus", onFocus); clearInterval(poll); };
  }, [queueRefresh, refresh]);

  const quoteBySymbol = useMemo(() => new Map(data.markets.map((quote) => [quote.symbol, quote])), [data.markets]);
  const exposure = data.portfolio?.positions.reduce((total, position) => total + Number(position.quantity) * Number(quoteBySymbol.get(position.symbol)?.bid ?? 0), 0) ?? 0;
  const equityValue = Number(data.portfolio?.equity ?? 0);
  const initialCash = Number(data.simulations.find((item) => item.id === simulationId)?.starting_cash ?? 0);
  const totalProfit = equityValue - initialCash;
  const exposurePercent = equityValue > 0 ? exposure / equityValue * 100 : 0;
  const returnPercent = initialCash > 0 ? totalProfit / initialCash * 100 : 0;
  const symbols = data.settings?.values.assets ?? ["BTCUSDT"];
  const pendingDecision = data.decisions.find((decision) => !decision.result && !decision.failure);
  const inFlightPromptVersion = pendingDecision?.prompt_version;
  const activeSimulation = data.simulations.find((simulation) => simulation.id === simulationId);

  return <main className="terminal-shell">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-icon" aria-hidden="true">P</span><span>Paper Investor<small>MARKET TERMINAL</small></span></a><div className="topbar-status"><span className="paper-label">PAPER TRADING</span><span className="provider-chip">{data.settings?.values.provider ?? "provider"} · {data.settings?.values.model ?? "loading"}</span><span className="connection"><i aria-hidden="true"/> LIVE DATA</span></div><label className="simulation-select"><span className="sr-only">Simulation history</span><select aria-label="Simulation" value={simulationId} onChange={(event) => { const id = event.target.value; setSimulationId(id); void refresh(id); }}><option value="" disabled>Select simulation</option>{data.simulations.map((simulation) => <option key={simulation.id} value={simulation.id}>{simulation.status === "active" ? "Active" : "Archived"} · {simulation.id.slice(0, 8)}</option>)}</select></label></header>
    <div className="dashboard-content" id="top">
      <div className="page-title"><div><p className="eyebrow">PORTFOLIO OVERVIEW</p><h1>Trading dashboard</h1><p className="subtitle">Paper execution · simulated balances only</p></div><div className="last-update">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Connecting…"}</div></div>
      <nav className="section-nav" aria-label="Dashboard sections"><a href="#agent-controls">Agent</a><a href="#prompt-editor">Prompts</a><a href="#settings">Settings</a><a href="#simulation-reset">Simulation</a></nav>
      {error && <div className="notice notice-error" role="alert"><strong>Dashboard data unavailable.</strong> {error} <button onClick={() => void refresh()}>Retry</button></div>}
      {loading && !updatedAt && <div className="notice" role="status">Connecting to local portfolio services…</div>}
      {data.portfolio?.dataStatus !== "available" && data.portfolio && <div className={`notice ${data.portfolio.dataStatus === "stale" ? "notice-warn" : "notice-error"}`} role="status">{data.portfolio.dataStatus === "stale" ? "Market data is stale. Portfolio value may not reflect current prices." : "Portfolio valuation is unavailable until fresh market data arrives."}</div>}
      <section className="metric-grid" aria-label="Portfolio summary">
        <Metric label="Total equity" value={formatMoney(data.portfolio?.equity)} detail="Cash + bid-valued positions" highlight/>
        <Metric label="Available cash" value={formatMoney(data.portfolio?.cash)} detail="USDT ledger balance"/>
        <Metric label="Total profit" value={formatMoney(Number.isFinite(totalProfit) && initialCash ? String(totalProfit) : null)} detail="Equity vs. starting cash" tone={totalProfit >= 0 ? "positive" : "negative"}/>
        <Metric label="Total return" value={initialCash ? `${returnPercent >= 0 ? "+" : ""}${returnPercent.toFixed(2)}%` : "—"} detail="Equity performance since funding" tone={totalProfit >= 0 ? "positive" : "negative"}/>
        <Metric label="Realized profit" value={formatMoney(data.portfolio?.realizedProfit)} detail="After sold-position cost basis"/>
        <Metric label="Gross exposure" value={`${exposurePercent.toFixed(2)}%`} detail={`${formatMoney(String(exposure))} at bid`}/>
      </section>

      <div className="chart-grid"><EquityChart points={data.equity}/><div className="market-chart-wrap"><label className="market-symbol-select">Market<select value={selectedSymbol} onChange={(event) => { const symbol = event.target.value; setSelectedSymbol(symbol); void api<CandleRow[]>(`/api/candles?symbol=${encodeURIComponent(symbol)}`).then((candles) => setData((current) => ({ ...current, candles }))).catch(() => setError("Could not load market candles")); }} aria-label="Market chart symbol">{symbols.map((symbol) => <option key={symbol}>{symbol}</option>)}</select></label><MarketChart symbol={selectedSymbol} candles={data.candles}/></div></div>

      <div className="content-grid"><div className="main-column"><Positions portfolio={data.portfolio}/><History trades={data.trades}/><p className="assumptions"><strong>Simulation assumptions</strong> Complete fills · configured fees · configured slippage · sell execution performance uses bid-side prices.</p></div><aside className="side-column"><Health health={data.health} settings={data.settings} updatedAt={updatedAt}/><Activity decisions={data.decisions}/><section className="panel market-snapshot"><div className="panel-heading"><div><p className="eyebrow">LIVE QUOTES</p><h2>Bid / ask</h2></div></div>{data.markets.length ? data.markets.map((quote) => <div className="quote-row" key={quote.symbol}><strong>{quote.symbol}</strong><span>{quote.bid} / {quote.ask}</span></div>) : <p className="empty">Waiting for exchange quotes</p>}</section></aside></div>
      <div className="workflow-grid"><Controls health={data.health} settings={data.settings} onRefresh={() => void refresh()}/><PromptEditor prompts={data.prompts} inFlightVersion={inFlightPromptVersion} onRefresh={() => void refresh()}/><Settings settings={data.settings} health={data.health} portfolio={data.portfolio} onRefresh={() => void refresh()}/><ResetDialog activeSimulation={activeSimulation} onReset={() => { setSimulationId(""); void refresh(""); }}/></div>
      <footer className="footer-note">Market history is for display. Rounded chart values never enter trade calculations.</footer>
    </div>
  </main>;
}

function Metric({ label, value, detail, highlight = false, tone = "" }: { label: string; value: string; detail: string; highlight?: boolean; tone?: string }) {
  return <article className={`metric-card ${highlight ? "metric-highlight" : ""}`}><span className="metric-label">{label}</span><strong className={`metric-value ${tone}`}>{value}</strong><span className="metric-detail">{detail}</span></article>;
}

function formatMoney(value?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}
