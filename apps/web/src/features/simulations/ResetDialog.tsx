import { useRef, useState } from "react";
import type { SimulationRow } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";

export function ResetDialog({ activeSimulation, onReset }: { activeSimulation: SimulationRow | undefined; onReset: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [startingCash, setStartingCash] = useState("10000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = () => { setError(""); dialog.current?.showModal(); };
  const reset = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await sendControl("/api/simulations", "POST", { startingCash, requestId: crypto.randomUUID() }); dialog.current?.close(); onReset(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Simulation could not be reset"); }
    finally { setBusy(false); }
  };
  return <section className="panel workflow-panel reset-panel" id="simulation-reset" aria-labelledby="reset-heading"><div><p className="eyebrow">SIMULATION LIFECYCLE</p><h2 id="reset-heading">Start a new simulation</h2><p className="control-summary">The current simulation and every decision, trade, and balance record will be archived and stay available in history.</p></div><button className="button-secondary" onClick={open}>Reset simulation</button><dialog ref={dialog} className="reset-dialog" aria-labelledby="reset-dialog-heading"><form onSubmit={(event) => void reset(event)} className="workflow-form"><p className="eyebrow">ARCHIVE AND RESET</p><h2 id="reset-dialog-heading">Fund a new simulation</h2><p>Current simulation {activeSimulation?.id.slice(0, 8) ?? "—"} will be archived. The new simulation starts paused with no positions.</p><label>Starting cash (USDT)<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,18})?" min="0.01" value={startingCash} onChange={(event) => setStartingCash(event.target.value)}/></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button disabled={busy}>{busy ? "Creating…" : "Archive and create"}</button></div></form></dialog></section>;
}
