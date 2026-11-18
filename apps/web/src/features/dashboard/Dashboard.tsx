import { Navigation } from "../../components/Navigation.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, simulationPath, type DecisionRow, type EquityPoint, type HealthData, type PortfolioData, type PromptRow, type QuoteRow, type SettingsData, type SimulationRow, type TradeRow } from "../../lib/api.js";
import { formatPrice } from "../../lib/format.js";
import { connectLiveEvents } from "../../lib/events.js";
import { Controls } from "../agent/Controls.js";
import { Activity } from "./Activity.js";
import { EquityChart } from "./EquityChart.js";
import { Health } from "./Health.js";
import { History } from "./History.js";
import { MarketBrowser } from "./MarketBrowser.js";
import { Positions } from "./Positions.js";
import { SettingsPage } from "../settings/SettingsPage.js";

interface DashboardData { simulations: SimulationRow[]; portfolio: PortfolioData | null; equity: EquityPoint[]; markets: QuoteRow[]; trades: TradeRow[]; decisions: DecisionRow[]; prompts: PromptRow[]; health: HealthData | null; settings: SettingsData | null; }
const emptyData: DashboardData = { simulations: [], portfolio: null, equity: [], markets: [], trades: [], decisions: [], prompts: [], health: null, settings: null };

export function Dashboard({ page, onNavigate, active = true }: { active?: boolean; page: "dashboard" | "settings"; onNavigate: (destination: "/" | "/settings" | "/agents" | "/reports") => void }) {
  const [data, setData] = useState(emptyData);
  const [simulationId, setSimulationId] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const selectedSimulationId = useRef("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async (requestedSimulation?: string): Promise<void> => {
    if (!active) return;
    if (abortRef.current && !abortRef.current.signal.aborted && requestedSimulation === undefined) { refreshQueued.current = true; return; }
    refreshQueued.current = false;
    if (requestedSimulation !== undefined) setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [simulations, health] = await Promise.all([api<SimulationRow[]>("/api/simulations", controller.signal), api<HealthData>("/api/health", controller.signal)]);
      if (controller.signal.aborted) return;
      const selection = requestedSimulation ?? (page === "settings" ? "" : selectedSimulationId.current);
      const currentId = selection || simulations.find((item) => item.status === "active")?.id || (page === "settings" ? "" : simulations[0]?.id) || "";
      if (!currentId) {
        setData({ ...emptyData, simulations, health }); selectedSimulationId.current = ""; setSimulationId(""); setUpdatedAt(new Date()); setError(""); return;
      }
      const paths = ["/api/portfolio", "/api/equity", "/api/markets", "/api/trades", "/api/decisions", "/api/health", "/api/settings"] as const;
      const [portfolio, equity, markets, trades, decisions, prompts, settings] = await Promise.all([
        api<PortfolioData>(simulationPath(paths[0], currentId), controller.signal),
        page === "dashboard" ? api<EquityPoint[]>(simulationPath(paths[1], currentId), controller.signal) : Promise.resolve([]),
        page === "dashboard" ? api<QuoteRow[]>(simulationPath(paths[2], currentId), controller.signal) : Promise.resolve([]),
        page === "dashboard" ? api<TradeRow[]>(simulationPath(paths[3], currentId), controller.signal) : Promise.resolve([]),
        api<DecisionRow[]>(simulationPath(paths[4], currentId), controller.signal),
        api<PromptRow[]>(simulationPath("/api/prompts", currentId), controller.signal),
        api<SettingsData | null>(paths[6], controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setData({ simulations, portfolio, equity: [...equity].reverse(), markets, trades, decisions, prompts, health, settings });
      selectedSimulationId.current = currentId; setSimulationId(currentId); setUpdatedAt(new Date()); setError("");
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return;
      setError(cause instanceof Error ? cause.message : "Could not load dashboard data");
      if (!refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = null; void refresh(); }, 5000);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (!controller.signal.aborted && refreshQueued.current) { refreshQueued.current = false; void refresh(); }
      }
    }
  }, [page, active]);

  const queueRefresh = useCallback(() => {
    if (document.visibilityState !== "visible" || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; void refresh(); }, 5000);
  }, [refresh]);

  useEffect(() => { void refresh(); return () => { abortRef.current?.abort(); refreshQueued.current = false; if (refreshTimer.current) clearTimeout(refreshTimer.current); refreshTimer.current = null; }; }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const disconnect = connectLiveEvents(queueRefresh, undefined, page === "settings" ? ["snapshot-required", "decision", "portfolio", "status", "team-run", "agents"] : undefined);
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => { disconnect(); document.removeEventListener("visibilitychange", onFocus); window.removeEventListener("focus", onFocus); clearInterval(poll); };
  }, [queueRefresh, refresh, active, page]);

  const quoteBySymbol = useMemo(() => new Map(data.markets.map((quote) => [quote.symbol, quote])), [data.markets]);
  const exposure = data.portfolio?.positions.reduce<number | null>((total, position) => {
    const quote = quoteBySymbol.get(position.symbol);
    return total === null || !quote ? null : total + Number(position.quantity) * Number(quote.bid);
  }, 0) ?? null;
  const equityValue = data.portfolio?.equity == null ? null : Number(data.portfolio.equity);
  const valuationAvailable = equityValue !== null && Number.isFinite(equityValue) && data.portfolio?.dataStatus !== "unavailable";
  const initialCash = Number(data.simulations.find((item) => item.id === simulationId)?.starting_cash ?? 0);
  const totalProfit = valuationAvailable ? equityValue - initialCash : null;
  const exposurePercent = valuationAvailable && exposure !== null && equityValue > 0 ? exposure / equityValue * 100 : null;
  const returnPercent = totalProfit !== null && initialCash > 0 ? totalProfit / initialCash * 100 : null;
  const pendingDecision = data.decisions.find((decision) => !decision.result && !decision.failure);
  const inFlightPromptVersion = pendingDecision?.prompt_version;
  const activeSimulation = data.simulations.find((simulation) => simulation.status === "active");

  if (page === "settings") return <SettingsPage settings={data.settings} health={data.health} portfolio={data.portfolio} prompts={data.prompts} inFlightPromptVersion={inFlightPromptVersion} activeSimulation={activeSimulation} updatedAt={updatedAt} error={error} loading={loading} onRefresh={() => void refresh()} onNavigate={onNavigate}/>;

  return <main className="terminal-shell">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-icon" aria-hidden="true">P</span><span>Paper Investor<small>MARKET TERMINAL</small></span></a><div className="topbar-status"><span className="paper-label">PAPER TRADING</span><span className="provider-chip">{data.settings?.values.provider ?? "provider"} · {data.settings?.values.model ?? "loading"}</span><span className={`connection ${data.health?.market === "healthy" ? "" : "is-stale"}`}><i aria-hidden="true"/> {data.health?.market === "healthy" ? "LIVE DATA" : "MARKET UNAVAILABLE"}</span></div><label className="simulation-select"><span className="sr-only">Simulation history</span><select aria-label="Simulation" value={simulationId} onChange={(event) => { selectedSimulationId.current = event.target.value; void refresh(event.target.value); }}><option value="" disabled>Select simulation</option>{data.simulations.map((simulation) => <option key={simulation.id} value={simulation.id}>{simulation.status === "active" ? "Active" : "Archived"} · {simulation.id.slice(0, 8)}</option>)}</select></label></header>
    <div className="dashboard-content" id="top">
      <div className="page-title"><div><p className="eyebrow">PORTFOLIO OVERVIEW</p><h1>Trading dashboard</h1><p className="subtitle">Paper execution · simulated balances only</p></div><div className="last-update">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Connecting…"}</div></div>
      <Navigation current="/" onNavigate={onNavigate}/>
      {error && <div className="notice notice-error" role="alert"><strong>Dashboard data unavailable.</strong> {error} Reconnecting automatically…</div>}
      {!loading && !error && !data.simulations.length && <div className="notice" role="status">Create your first simulation in Settings to fund a paper portfolio.</div>}
      {loading && updatedAt && <div className="notice" role="status">Loading selected simulation…</div>}
      {loading && !updatedAt && <div className="notice" role="status">Connecting to local portfolio services…</div>}
      {data.portfolio?.dataStatus !== "available" && data.portfolio && <div className={`notice ${data.portfolio.dataStatus === "stale" ? "notice-warn" : "notice-error"}`} role="status">{data.portfolio.dataStatus === "stale" ? "Market data is stale. Portfolio value may not reflect current prices." : "Portfolio valuation is unavailable until fresh market data arrives."}</div>}
      {active && simulationId === activeSimulation?.id && <Controls dashboard health={data.health} settings={data.settings} unavailable={!!error || loading} onRefresh={() => void refresh()}/>}
      <section className="metric-grid" aria-label="Portfolio summary">
        <Metric label="Total equity" value={formatMoney(data.portfolio?.equity)} detail="Cash + bid-valued positions" highlight/>
        <Metric label="Available cash" value={formatMoney(data.portfolio?.cash)} detail="USDT ledger balance"/>
        <Metric label="Total profit" value={formatMoney(totalProfit === null ? null : String(totalProfit))} detail="Equity vs. starting cash" tone={totalProfit === null ? "" : totalProfit >= 0 ? "positive" : "negative"}/>
        <Metric label="Total return" value={returnPercent === null ? "—" : `${returnPercent >= 0 ? "+" : ""}${returnPercent.toFixed(2)}%`} detail="Equity performance since funding" tone={totalProfit === null ? "" : totalProfit >= 0 ? "positive" : "negative"}/>
        <Metric label="Realized profit" value={formatMoney(data.portfolio?.realizedProfit)} detail="After sold-position cost basis"/>
        <Metric label="Gross exposure" value={exposurePercent === null ? "—" : `${exposurePercent.toFixed(2)}%`} detail={exposure === null ? "Awaiting market valuation" : `${formatMoney(String(exposure))} at bid`}/>
      </section>

      <div className="chart-grid"><EquityChart key={data.portfolio?.simulationId} points={data.equity}/><MarketBrowser active={active}/></div>

      <div className="content-grid"><div className="main-column"><Positions portfolio={data.portfolio}/><History trades={data.trades}/><p className="assumptions"><strong>Simulation assumptions</strong> Complete fills · configured fees · configured slippage · sell execution performance uses bid-side prices.</p></div><aside className="side-column"><Health health={data.health} settings={data.settings} updatedAt={updatedAt}/><Activity decisions={data.decisions}/><section className="panel market-snapshot"><div className="panel-heading"><div><p className="eyebrow">LIVE QUOTES</p><h2>Bid / ask</h2></div></div>{data.markets.length ? data.markets.map((quote) => <div className="quote-row" key={quote.symbol}><strong>{quote.symbol}</strong><span>{formatPrice(quote.bid)} / {formatPrice(quote.ask)}</span></div>) : <p className="empty">Waiting for exchange quotes</p>}</section></aside></div>
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
