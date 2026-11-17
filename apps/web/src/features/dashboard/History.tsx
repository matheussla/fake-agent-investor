import type { TradeRow } from "../../lib/api.js";

export function History({ trades }: { trades: TradeRow[] }) {
  return <section className="panel" aria-labelledby="history-heading"><div className="panel-heading"><div><p className="eyebrow">EXECUTION LEDGER</p><h2 id="history-heading">Recent trades</h2></div></div><div className="table-wrap"><table><thead><tr><th scope="col">Time</th><th scope="col">Asset</th><th scope="col">Side</th><th scope="col">Status</th><th scope="col">Fee</th></tr></thead><tbody>{trades.length ? trades.map((trade) => <tr key={trade.id}><td>{new Date(trade.created_at).toLocaleTimeString()}</td><th scope="row">{trade.symbol}</th><td><span className={`side side-${trade.side}`}>{trade.side}</span></td><td>{trade.status}{trade.reason ? ` · ${trade.reason}` : ""}</td><td>{trade.fee ?? "—"}</td></tr>) : <tr><td colSpan={5} className="empty">No trades recorded</td></tr>}</tbody></table></div></section>;
}
