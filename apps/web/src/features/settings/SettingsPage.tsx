import type { HealthData, PortfolioData, PromptRow, SettingsData, SimulationRow } from "../../lib/api.js";
import { Controls } from "../agent/Controls.js";
import { PromptEditor } from "../prompts/PromptEditor.js";
import { Settings } from "./Settings.js";
import { SimulationBalance } from "./SimulationBalance.js";

export function SettingsPage({ settings, health, portfolio, prompts, inFlightPromptVersion, activeSimulation, updatedAt, error, loading, onRefresh, onNavigate }: {
  settings: SettingsData | null;
  health: HealthData | null;
  portfolio: PortfolioData | null;
  prompts: PromptRow[];
  inFlightPromptVersion?: number;
  activeSimulation?: SimulationRow;
  updatedAt: Date | null;
  error: string;
  loading: boolean;
  onRefresh: () => void;
  onNavigate: (destination: "/" | "/settings") => void;
}) {
  return <main className="terminal-shell">
    <header className="topbar"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/"); }}><span className="brand-icon" aria-hidden="true">P</span><span>Paper Investor<small>MARKET TERMINAL</small></span></a><div className="topbar-status"><span className="paper-label">PAPER TRADING</span><span className="provider-chip">{settings?.values.provider ?? "provider"} · {settings?.values.model ?? "loading"}</span></div><span className="muted">{activeSimulation ? `SIM ${activeSimulation.id.slice(0, 8)}` : "NO ACTIVE SIMULATION"}</span></header>
    <div className="dashboard-content settings-content" id="top">
      <div className="page-title"><div><p className="eyebrow">CONFIGURATION</p><h1>Settings</h1><p className="subtitle">Funding, trading parameters, strategy prompts, and agent controls.</p></div><div className="last-update">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Connecting…"}</div></div>
      <nav className="section-nav" aria-label="Main navigation"><a href="/" onClick={(event) => { event.preventDefault(); onNavigate("/"); }}>Dashboard</a><a href="/settings" aria-current="page">Settings</a></nav>
      {error && <div className="notice notice-error" role="alert"><strong>Settings could not load.</strong> {error} <button onClick={onRefresh}>Retry</button></div>}
      {loading && !activeSimulation && <div className="notice" role="status">Loading simulation settings…</div>}
      {!loading && !error && !activeSimulation && <SimulationBalance onCreated={onRefresh}/>}
      {!loading && !error && activeSimulation && <>
        <div className="settings-layout">
          <div className="settings-primary"><Controls health={health} settings={settings} onRefresh={onRefresh}/><SimulationBalance activeSimulation={activeSimulation} onCreated={onRefresh}/><Settings settings={settings} health={health} portfolio={portfolio} simulationId={activeSimulation.id} onRefresh={onRefresh}/></div>
          <PromptEditor prompts={prompts} inFlightVersion={inFlightPromptVersion} onRefresh={onRefresh}/>
        </div>
      </>}
      <footer className="footer-note">Configuration changes apply to future decisions. Positions and simulated balances remain unchanged.</footer>
    </div>
  </main>;
}
