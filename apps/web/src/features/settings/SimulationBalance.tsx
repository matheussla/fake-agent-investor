import { useRef, useState } from "react";
import type { SimulationRow } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";

export function SimulationBalance({ activeSimulation, onCreated }: { activeSimulation?: SimulationRow; onCreated: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [startingCash, setStartingCash] = useState(activeSimulation?.starting_cash ?? "10000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!Number.isFinite(Number(startingCash)) || Number(startingCash) <= 0) { setError("Enter a starting balance greater than 0 USDT."); return; }
    setBusy(true); setError("");
    try {
      await sendControl("/api/simulations", "POST", { startingCash, requestId: crypto.randomUUID() });
      dialog.current?.close(); onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Simulation could not be created"); }
    finally { setBusy(false); }
  };

  if (!activeSimulation) return <section className="panel workflow-panel" aria-labelledby="initial-balance-heading"><div className="panel-heading"><div><p className="eyebrow">FIRST RUN</p><h2 id="initial-balance-heading">Set your starting balance</h2></div></div><p className="control-summary">Choose the USDT balance for your first paper simulation. It will stay fixed for this simulation; you can choose a new balance only when you reset it.</p><form onSubmit={(event) => void create(event)} className="workflow-form"><label>Starting balance (USDT)<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,18})?" min="0.01" value={startingCash} onChange={(event) => setStartingCash(event.target.value)}/></label><button disabled={busy}>{busy ? "Creating…" : "Create simulation"}</button></form>{error && <p className="form-error" role="alert">{error}</p>}</section>;

  return <section className="panel workflow-panel" aria-labelledby="balance-heading"><div className="panel-heading"><div><p className="eyebrow">SIMULATION BALANCE</p><h2 id="balance-heading">Starting balance</h2></div></div><strong className="balance-value">{Number(activeSimulation.starting_cash).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT</strong><p className="control-summary">This amount is locked for the current simulation. Reset the simulation to archive its history and set a new starting balance.</p><button className="button-secondary" onClick={() => { setStartingCash(activeSimulation.starting_cash); setError(""); dialog.current?.showModal(); }}>Reset simulation</button><dialog ref={dialog} className="reset-dialog" aria-labelledby="reset-dialog-heading"><form onSubmit={(event) => void create(event)} className="workflow-form"><p className="eyebrow">ARCHIVE AND RESET</p><h2 id="reset-dialog-heading">Set a new starting balance</h2><p>Current simulation {activeSimulation.id.slice(0, 8)} will be archived. Its decisions, trades, and balance records will remain in history.</p><label>Starting balance (USDT)<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,18})?" min="0.01" value={startingCash} onChange={(event) => setStartingCash(event.target.value)}/></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button disabled={busy}>{busy ? "Creating…" : "Archive and create"}</button></div></form></dialog></section>;
}
