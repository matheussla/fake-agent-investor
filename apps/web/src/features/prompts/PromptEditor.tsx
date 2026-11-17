import { useState } from "react";
import type { PromptRow } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";

export function PromptEditor({ prompts, inFlightVersion, onRefresh }: { prompts: PromptRow[]; inFlightVersion?: number; onRefresh: () => void }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const active = prompts.find((prompt) => prompt.active);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try { const prompt = await sendControl<PromptRow>("/api/prompts", "POST", { name, content }); setMessage(`Saved ${prompt.name} version ${prompt.version}. Activate it when ready.`); setContent(""); onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Prompt could not be saved"); }
    finally { setBusy(false); }
  };
  const activate = async (prompt: PromptRow) => {
    setBusy(true); setError(""); setMessage("");
    try { await sendControl(`/api/prompts/${prompt.id}/activate`, "POST", { promptVersionId: prompt.id }); setMessage(`Activated ${prompt.name} version ${prompt.version} for future decisions.`); onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Prompt could not be activated"); }
    finally { setBusy(false); }
  };
  return <section className="panel workflow-panel" id="prompt-editor" aria-labelledby="prompt-editor-heading"><div className="panel-heading"><div><p className="eyebrow">STRATEGY</p><h2 id="prompt-editor-heading">Prompt versions</h2></div></div><div className="version-status"><span>Active version</span><strong>{active ? `${active.name} · v${active.version}` : "No active prompt"}</strong>{inFlightVersion && <span>Decision in progress captured prompt v{inFlightVersion}</span>}</div><form onSubmit={(event) => void save(event)} className="workflow-form"><label>Prompt name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Trend following"/></label><label>Strategy prompt<textarea required maxLength={12_000} rows={5} value={content} onChange={(event) => setContent(event.target.value)} placeholder="Describe the strategy. Risk rules are enforced separately."/></label><button disabled={busy}>{busy ? "Saving…" : "Save new version"}</button></form><div className="version-list" aria-label="Saved prompt versions">{prompts.map((prompt) => <div className="version-row" key={prompt.id}><div><strong>{prompt.name} · v{prompt.version}</strong><p>{prompt.active ? "Active for new captures" : "Saved"}</p></div><button className="button-secondary" disabled={busy || prompt.active} onClick={() => void activate(prompt)}>{prompt.active ? "Active" : "Activate"}</button></div>)}</div>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}</section>;
}
