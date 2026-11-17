import type { HealthData, PortfolioData, PromptRow, SettingsData, SimulationRow } from "../../lib/api.js";
import { PromptEditor } from "../prompts/PromptEditor.js";
import { Settings } from "./Settings.js";

export function SettingsPage({ settings, health, portfolio, prompts, inFlightPromptVersion, simulations, simulationId, updatedAt, onRefresh, onNavigate, onSelectSimulation }: {
  settings: SettingsData | null;
  health: HealthData | null;
  portfolio: PortfolioData | null;
  prompts: PromptRow[];
  inFlightPromptVersion?: number;
  simulations: SimulationRow[];
  simulationId: string;
  updatedAt: Date | null;
  onRefresh: () => void;
  onNavigate: (destination: "/" | "/settings") => void;
  onSelectSimulation: (simulationId: string) => void;
}) {
  return <main className="terminal-shell">
    <header className="topbar"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/"); }}><span className="brand-icon" aria-hidden="true">P</span><span>Paper Investor<small>MARKET TERMINAL</small></span></a><div className="topbar-status"><span className="paper-label">PAPER TRADING</span><span className="provider-chip">{settings?.values.provider ?? "provider"} · {settings?.values.model ?? "loading"}</span></div><label className="simulation-select"><span className="sr-only">Simulation history</span><select aria-label="Simulation" value={simulationId} onChange={(event) => onSelectSimulation(event.target.value)}><option value="" disabled>Select simulation</option>{simulations.map((simulation) => <option key={simulation.id} value={simulation.id}>{simulation.status === "active" ? "Active" : "Archived"} · {simulation.id.slice(0, 8)}</option>)}</select></label></header>
    <div className="dashboard-content settings-content" id="top">
      <div className="page-title"><div><p className="eyebrow">CONFIGURATION</p><h1>Settings</h1><p className="subtitle">Trading parameters and strategy prompts for the selected simulation.</p></div><div className="last-update">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Connecting…"}</div></div>
      <nav className="section-nav" aria-label="Main navigation"><a href="/" onClick={(event) => { event.preventDefault(); onNavigate("/"); }}>Dashboard</a><a href="/settings" aria-current="page">Settings</a></nav>
      <div className="settings-layout"><Settings settings={settings} health={health} portfolio={portfolio} onRefresh={onRefresh}/><PromptEditor prompts={prompts} inFlightVersion={inFlightPromptVersion} onRefresh={onRefresh}/></div>
      <footer className="footer-note">Configuration changes apply to future decisions. Positions and simulated balances remain unchanged.</footer>
    </div>
  </main>;
}
