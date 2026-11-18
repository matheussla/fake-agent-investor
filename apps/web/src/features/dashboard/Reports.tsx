import { useEffect, useState } from "react";
import { api, simulationPath } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";

interface SavedReport { id: string; decision_id: string; outcome: string; created_at: string; started_at?: string; deleted?: boolean; metrics: { fees: string; realizedProfitNetOfTradingFees: string; modelCalls: number | null }; }
function dateBoundary(value: string, nextDay = false): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}
export function Reports({ simulationId, active }: { simulationId: string; active: boolean }) {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [deleted, setDeleted] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !simulationId) return;
    const controller = new AbortController();
    let pending = false;
    setReports([]); setLoading(true); setError("");
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const query = new URLSearchParams({ limit: "20", deleted: String(deleted) });
        if (before) query.set("before", before);
        if (range.from) query.set("from", dateBoundary(range.from));
        if (range.to) query.set("to", dateBoundary(range.to, true));
        const rows = await api<SavedReport[]>(simulationPath(`/api/reports?${query}`, simulationId), controller.signal);
        if (!controller.signal.aborted) { setReports(rows); setError(""); }
      } catch { if (!controller.signal.aborted) setError("Reports unavailable. Retrying automatically…"); }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [simulationId, active, before, range, deleted, revision]);
  const changeReport = async (id: string, restore: boolean) => {
    setBusy(true); setActionError("");
    try {
      await sendControl(`/api/reports/${id}${restore ? "/restore" : ""}`, restore ? "POST" : "DELETE", {});
      setUndoId(restore ? null : id); setRevision(value => value + 1);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Report update failed"); }
    finally { setBusy(false); }
  };
  return <section className="panel" aria-labelledby="reports-heading">
    <div className="panel-heading"><div><p className="eyebrow">SAVED ANALYSIS DATA</p><h2 id="reports-heading">Trading reports</h2></div></div>
    <p className="control-summary">Each evaluation saves its evidence, agent contributions, fees, and realized results. Download JSON for future analysis. Reports do not automatically change strategies.</p>
    <form className="control-actions report-filters" onSubmit={event => { event.preventDefault(); if (from && to && from > to) { setActionError("Start date must be on or before end date."); return; } setActionError(""); setBefore(null); setRange({ from, to }); }}>
      <label>Start date<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
      <label>End date<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label>
      <button type="submit">Apply dates</button>
      <button type="button" className="button-secondary" onClick={() => { setFrom(""); setTo(""); setRange({ from: "", to: "" }); setBefore(null); setActionError(""); }}>Clear dates</button>
      <label><input type="checkbox" checked={deleted} onChange={event => { setDeleted(event.target.checked); setBefore(null); }}/> Show deleted reports</label>
    </form>
    <p className="control-summary">Dates use your local timezone and include the entire end date. Filtered by evaluation start time. Deleting a report leaves trades and balances unchanged; restore it from deleted reports.</p>
    {undoId && <p role="status">Report deleted. <button className="button-secondary" disabled={busy} onClick={() => void changeReport(undoId, true)}>Undo delete</button></p>}
    {actionError && <p role="alert">{actionError}</p>}{error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading saved reports…</p>}
    {!loading && !reports.length && !error && <p className="empty">{range.from || range.to || deleted ? "No reports match these filters." : "No saved reports yet."}</p>}
    {reports.map(report => <article className="report-entry" key={report.id}><p className="control-summary">
      {report.deleted ? <strong>{report.outcome} report · {report.decision_id.slice(0, 8)}</strong> : <a href={`/api/reports/${report.id}`} download>Download {report.outcome} report · {report.decision_id.slice(0, 8)}</a>}
      {report.started_at && <> · <time dateTime={report.started_at}>{new Date(report.started_at).toLocaleString()}</time></>}
      {' · '}Fees {Number(report.metrics.fees).toFixed(4)} USDT · Realized P/L {Number(report.metrics.realizedProfitNetOfTradingFees).toFixed(4)} USDT · {report.metrics.modelCalls ?? "Unknown"} calls
    </p><button className="button-secondary" disabled={busy} aria-label={`${report.deleted ? "Restore" : "Delete"} report ${report.decision_id.slice(0, 8)}`} onClick={() => void changeReport(report.id, !!report.deleted)}>{report.deleted ? "Restore" : "Delete"}</button></article>)}
    <div className="control-actions"><button className="button-secondary" disabled={!before || loading} onClick={() => setBefore(null)}>Latest reports</button><button className="button-secondary" disabled={loading || reports.length < 20} onClick={() => setBefore(reports.at(-1)!.created_at)}>Older reports</button></div>
  </section>;
}
