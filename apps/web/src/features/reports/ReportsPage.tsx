import { Navigation } from "../../components/Navigation.js";
import { useEffect, useState } from "react";
import { api, type SimulationRow } from "../../lib/api.js";
import { Reports } from "../dashboard/Reports.js";

export function ReportsPage({ active, onNavigate }: { active: boolean; onNavigate: (path: "/" | "/agents" | "/reports" | "/settings") => void }) {
  const [simulations, setSimulations] = useState<SimulationRow[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const rows = await api<SimulationRow[]>("/api/simulations", controller.signal);
        if (!controller.signal.aborted) { setSimulations(rows); setError(""); }
      } catch { if (!controller.signal.aborted) setError("Simulation history unavailable. Retrying automatically…"); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active]);
  const simulationId = selected || simulations.find(simulation => simulation.status === "active")?.id || simulations[0]?.id || "";
  return <main className="terminal-shell">
    <header className="topbar"><a className="brand" href="/" onClick={event => { event.preventDefault(); onNavigate("/"); }}><span className="brand-icon" aria-hidden="true">P</span><span>Paper Investor<small>REPORT ARCHIVE</small></span></a><span className="paper-label">PAPER TRADING</span><label className="simulation-select"><span>Simulation</span><select aria-label="Simulation" value={simulationId} onChange={event => setSelected(event.target.value)}><option value="" disabled>Select simulation</option>{simulations.map(simulation => <option key={simulation.id} value={simulation.id}>{simulation.status === "active" ? "Active" : "Archived"} · {simulation.id.slice(0, 8)}</option>)}</select></label></header>
    <div className="dashboard-content"><div className="page-title"><div><p className="eyebrow">EVIDENCE & PERFORMANCE</p><h1>Reports</h1><p className="subtitle">Saved trading decisions, agent contributions, fees, and realized results.</p></div></div>
      <Navigation current="/reports" onNavigate={onNavigate}/>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {loading && <p role="status">Loading report archive…</p>}
      {!loading && !error && !simulationId && <p className="notice">No simulations yet. Create one in Settings to start collecting reports.</p>}
      {simulationId && <Reports key={simulationId} simulationId={simulationId} active={active}/>}
    </div>
  </main>;
}
