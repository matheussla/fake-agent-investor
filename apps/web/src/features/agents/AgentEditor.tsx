import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";
import type { TeamAgent, TeamPrompt } from "./types.js";

export function AgentEditor({ agent, simulationId, editable, onClose, onSaved }: { agent: TeamAgent | null; simulationId: string; editable: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [content, setContent] = useState("");
  const [prompts, setPrompts] = useState<TeamPrompt[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [promptLoaded, setPromptLoaded] = useState(!agent);
  const [loading, setLoading] = useState(!!agent);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (!agent) return;
    const controller = new AbortController();
    const load = async () => {
      setLoading(true); setPromptLoaded(false); setError("");
      try {
        const values = await api<TeamPrompt[]>(`/api/agents/${agent.id}/prompts?simulationId=${simulationId}`, controller.signal);
        if (controller.signal.aborted) return;
        setPrompts(values); setContent(values.find((value) => value.active)?.content ?? ""); setPromptLoaded(true);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load prompts"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    return () => controller.abort();
  }, [agent?.id, simulationId, loadAttempt]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); onSaved(); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save agent"); } finally { setBusy(false); }
  };
  return <aside className="panel agent-editor" aria-label={agent ? "Edit agent" : "Create agent"}>
    <div className="panel-heading"><h2>{agent ? "Agent configuration" : "New agent"}</h2><button className="plain-button" onClick={onClose}>Close</button></div>
    {!editable && <p className="notice">Pause the team and finish queued work to edit.</p>}
    <form className="workflow-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      if (!agent) return sendControl("/api/agents", "POST", { name, prompt: content });
      await sendControl(`/api/agents/${agent.id}`, "PATCH", { name });
      if (content !== prompts.find((prompt) => prompt.active)?.content) { const saved = await sendControl<TeamPrompt>(`/api/agents/${agent.id}/prompts`, "POST", { content }); await sendControl(`/api/agents/${agent.id}/prompts/${saved.id}/activate`, "POST", {}); }
    }); }}>
      <label>Agent name<input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)}/></label>
      <label>Agent prompt<textarea disabled={!promptLoaded} required rows={12} maxLength={12000} value={content} onChange={(event) => setContent(event.target.value)}/></label>
      <p className="field-help">Give this agent a specific role. All agents share the same portfolio and risk limits.</p>
      <button disabled={busy || !editable || !promptLoaded}>{busy ? "Saving…" : agent ? "Save agent and prompt" : "Create agent"}</button>
    </form>
    {agent && <><div className="control-actions editor-actions"><button disabled={!editable || busy || agent.isLead} onClick={() => void perform(() => sendControl(`/api/agents/${agent.id}`, "PATCH", { enabled: !agent.enabled }))}>{agent.enabled ? "Disable agent" : "Enable agent"}</button><button disabled={!editable || busy || agent.isLead} onClick={() => void perform(() => sendControl(`/api/agents/${agent.id}`, "PATCH", { isLead: true, enabled: true }))}>Make lead</button><button disabled={!editable || busy || agent.isLead} onClick={() => void perform(() => sendControl(`/api/agents/${agent.id}`, "PATCH", { archived: true }))}>Archive agent</button></div><h3>Prompt versions</h3><div className="version-list">{prompts.map((prompt) => <div className="version-row" key={prompt.id}><span>Version {prompt.version} {prompt.active ? "· Active" : ""}</span><button disabled={!editable || busy || prompt.active} onClick={() => void perform(() => sendControl(`/api/agents/${agent.id}/prompts/${prompt.id}/activate`, "POST", {}))}>Activate</button></div>)}</div></>}
    {loading && <p role="status" className="control-summary">Loading agent prompt…</p>}
    {error && <p role="alert" className="form-error">{error}{!promptLoaded && <button type="button" disabled={loading} onClick={() => setLoadAttempt((value) => value + 1)}>Retry prompt</button>}</p>}
  </aside>;
}
