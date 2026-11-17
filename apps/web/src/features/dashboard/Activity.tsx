import type { DecisionRow } from "../../lib/api.js";

export function Activity({ decisions }: { decisions: DecisionRow[] }) {
  return <section className="panel" aria-labelledby="activity-heading"><div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2 id="activity-heading">Agent activity</h2></div></div>{decisions.length ? <ol className="activity-list">{decisions.slice(0, 8).map((item) => <li key={item.id}><span className={`activity-dot ${item.failure ? "is-failed" : ""}`} aria-hidden="true"/><div><strong>{item.failure ? "Decision failed" : describeResult(item.result)}</strong><p>{item.failure ?? new Date(item.created_at).toLocaleString()}</p></div></li>)}</ol> : <p className="empty">No decisions recorded</p>}</section>;
}

function describeResult(result: unknown): string {
  if (typeof result !== "object" || result === null || !("decision" in result)) return "Decision pending";
  const decision = result.decision;
  if (typeof decision !== "object" || decision === null || !("action" in decision)) return "Decision recorded";
  return `Model chose ${String(decision.action).toUpperCase()}`;
}
