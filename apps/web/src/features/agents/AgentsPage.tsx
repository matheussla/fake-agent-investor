import { Navigation } from "../../components/Navigation.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, simulationPath, type HealthData, type SettingsData, type SimulationRow } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";
import { runOnce } from "../../lib/run-once.js";
import { UsageMeter } from "./UsageMeter.js";
import { AgentEditor } from "./AgentEditor.js";
import type { TeamAgent, TeamMessage, TeamRun, MessagePage } from "./types.js";

const activeStatuses = ["queued", "working", "running", "waiting"];
export function AgentsPage({ onNavigate, active = true }: { active?: boolean; onNavigate: (path: "/" | "/settings" | "/agents" | "/reports") => void }) {
  const [simulations, setSimulations] = useState<SimulationRow[]>([]);
  const [simulationId, setSimulationId] = useState("");
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [runDetail, setRunDetail] = useState<{ run: TeamRun; turns: Array<{id: string; agentId: string; status: string; error?: string}> } | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [target, setTarget] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<TeamAgent | "new" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showRoster, setShowRoster] = useState(true);
  const [hasOlder, setHasOlder] = useState(true);
  const cursor = useRef<string | null>(null);
  const pendingSend = useRef<{ content: string; target: string; requestId: string } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const sims = await api<SimulationRow[]>("/api/simulations", signal);
      const id = simulationId || sims.find((item) => item.status === "active")?.id;
      setSimulations(sims);
      if (!id) { setLoading(false); return; }
      if (!simulationId) { setSimulationId(id); return; }
      const [roster, history, activity, currentHealth, currentSettings, recent] = await Promise.all([
        api<TeamAgent[]>(simulationPath("/api/agents", id), signal),
        api<MessagePage>(simulationPath(`/api/chat/messages?limit=100${cursor.current ? `&after=${encodeURIComponent(cursor.current)}` : ""}`, id), signal),
        api<TeamRun[]>(simulationPath("/api/team/runs", id), signal),
        api<HealthData>("/api/health", signal), api<SettingsData>("/api/settings", signal),
        cursor.current ? api<MessagePage>(simulationPath("/api/chat/messages?limit=100", id), signal) : Promise.resolve(null),
      ]);
      if (signal?.aborted) return;
      setTarget((current) => current && !roster.some((agent) => agent.id === current && !agent.archived) ? "" : current);
      setAgents(roster); setRuns(activity); setHealth(currentHealth); setSettings(currentSettings);
      setMessages((current) => [...new Map([...current, ...history.messages, ...(recent?.messages ?? [])].map((message) => [message.id, message])).values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : BigInt(a.cursor) > BigInt(b.cursor) ? 1 : 0)));
      if (history.messages.length) cursor.current = history.messages.at(-1)!.cursor;
      setError(""); setLoading(false);
    } catch (cause) { if (!signal?.aborted) { setError(cause instanceof Error ? cause.message : "Could not load team"); setLoading(false); } }
  }, [simulationId]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let refreshing = false;
    let again = false;
    const update = async () => {
      if (refreshing) { again = true; return; }
      refreshing = true;
      do { again = false; await refresh(controller.signal); } while (again && !controller.signal.aborted);
      refreshing = false;
    };
    void update();
    const source = new EventSource("/api/events");
    source.onopen = () => void update();
    for (const event of ["chat-message", "team-run", "agents", "snapshot-required", "status"]) source.addEventListener(event, () => void update());
    const poll = setInterval(() => void update(), 5000);
    return () => { controller.abort(); source.close(); clearInterval(poll); };
  }, [refresh, active]);
  const readonly = simulations.find((item) => item.id === simulationId)?.status !== "active";
  const activeRuns = runs.filter((run) => activeStatuses.includes(run.status));
  const editable = !readonly && !!health?.agent?.paused && !health.agent.cycleRunning && !activeRuns.length;
  const provider = settings?.values.provider;
  const providerReady = (provider === "grok" || provider === "codex") && health?.providers[provider] === "configured";
  const selected = agents.find((agent) => agent.id === target);
  const draftKey = `${simulationId}:${target}`;
  const draft = drafts[draftKey] ?? "";
  const visible = target ? messages.filter((message) => message.senderAgentId === target || message.recipientAgentId === target) : messages;
  const perform = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action(); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed"); } finally { setBusy(false); } };
  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    if (pendingSend.current?.content !== content || pendingSend.current.target !== target) pendingSend.current = { content, target, requestId: crypto.randomUUID() };
    await sendControl("/api/chat/messages", "POST", { requestId: pendingSend.current.requestId, targetAgentId: target || null, content });
    pendingSend.current = null;
    setDrafts((current) => ({ ...current, [draftKey]: "" }));
  };
  return <main className="terminal-shell"><header className="topbar"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/"); }}><span className="brand-icon">P</span><span>Paper Investor<small>AGENT WORKSPACE</small></span></a><span className="paper-label">PAPER TRADING</span><label className="simulation-select"><span className="sr-only">Simulation</span><select aria-label="Simulation" value={simulationId} onChange={(event) => { cursor.current = null; pendingSend.current = null; setMessages([]); setAgents([]); setRuns([]); setTarget(""); setRunDetail(null); setEditor(null); setHasOlder(true); setSimulationId(event.target.value); }}><option value="" disabled>Select simulation</option>{simulations.map((simulation) => <option key={simulation.id} value={simulation.id}>{simulation.status} · {simulation.id.slice(0, 8)}</option>)}</select></label></header>
    <div className="dashboard-content"><div className="page-title"><div><p className="eyebrow">ONE PORTFOLIO · MANY PERSPECTIVES</p><h1>Your trading team</h1><p className="subtitle">Independent prompts. Visible collaboration. One accountable lead.</p></div></div><Navigation current="/agents" onNavigate={onNavigate}/>
    {error && <div role="alert" className="notice notice-error">{error} <button onClick={() => void refresh()}>Retry</button></div>}
    {loading && <p role="status" className="notice">Loading your team…</p>}
    {!loading && !simulationId && <p className="notice">Create a simulation in Settings to configure your team.</p>}
    {simulationId && <><section className="panel team-toolbar"><div><strong>{readonly ? "Archived team" : health?.agent?.paused ? "Team paused" : "Team running"}</strong>{!readonly && health?.agent && !health.agent.paused && <p className="control-summary">Continuous trading is active. The next evaluation starts immediately after the previous one finishes. Use Pause team to stop. Automatic cutoff: 95% of the app call budget.</p>}<p className="control-summary">Model calls today: {health?.usage.dailyAttempts ?? 0} / {settings?.values.dailyAttemptLimit ?? 300}. Chat is discussion-only.</p></div><div className="control-actions"><button disabled={readonly || busy || !health?.agent?.paused || !!activeRuns.length || !providerReady} onClick={() => void perform(() => sendControl("/api/agent/start", "POST", {}))}>Start team</button><button disabled={readonly || busy || (!activeRuns.length && !!health?.agent?.paused)} onClick={() => void perform(() => sendControl("/api/agent/pause", "POST", { reason: "manual" }))}>Pause team</button><button disabled={!editable || busy || !providerReady} onClick={() => void perform(() => runOnce(simulationId))}>Run once</button></div></section>
    <UsageMeter health={health} settings={settings} stale={!!error}/>
    <div className="control-actions mobile-team-toggle"><button onClick={() => setShowRoster(!showRoster)}>{showRoster ? "Show conversation" : "Show agents"}</button></div>
    <div className={`agents-layout ${showRoster ? "show-roster" : "show-conversation"}`}><aside className="panel agent-roster"><div className="panel-heading"><h2>Agents</h2><span className="muted">{agents.filter((agent) => !agent.archived).length}/10</span></div><button className={`roster-item ${!target ? "selected" : ""}`} onClick={() => { setTarget(""); setShowRoster(false); }} aria-pressed={!target}><strong>Team conversation</strong><span>All messages and handoffs</span></button>{agents.filter((agent) => !agent.archived).map((agent) => <button className={`roster-item ${target === agent.id ? "selected" : ""}`} key={agent.id} aria-pressed={target === agent.id} onClick={() => { setTarget(agent.id); setShowRoster(false); }}><strong>{agent.name}{agent.isLead ? " · Lead" : ""}{!agent.enabled ? " · Disabled" : ""}</strong><span>{agent.prompt?.trim().split(/(?<=[.!?])\s+/)[0] || "No description provided."}</span></button>)}<div className="control-actions editor-actions"><button disabled={!editable || agents.filter((agent) => !agent.archived).length >= 10} onClick={() => setEditor("new")}>Add agent</button></div></aside>
    <section className="panel team-conversation" aria-label="Conversation"><div className="panel-heading"><div><p className="eyebrow">{target ? "INDIVIDUAL CHAT" : "TEAM ACTIVITY"}</p><h2>{selected?.name ?? "Team conversation"}</h2></div>{selected && <button className="plain-button" onClick={() => setEditor(selected)}>Configure agent</button>}</div><div className="chat-transcript" role="log" aria-live="polite" aria-relevant="additions"><button className="plain-button" disabled={!hasOlder || !messages.length || busy} onClick={() => void perform(async () => { const page = await api<MessagePage>(simulationPath(`/api/chat/messages?limit=100&before=${messages[0].cursor}`, simulationId)); setMessages((current) => [...new Map([...page.messages, ...current].map((item) => [item.id, item])).values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : BigInt(a.cursor) > BigInt(b.cursor) ? 1 : 0))); setHasOlder(page.messages.length === 100); })}>Load older messages</button>{!visible.length && <p className="empty">No messages yet. Give the team a question or start a trading cycle.</p>}{visible.map((message) => <article key={message.id} className={`chat-message message-${message.kind ?? "message"}`}><header><strong>{message.senderName || agents.find((agent) => agent.id === message.senderAgentId)?.name || "You"}</strong><span>to {message.recipientName ?? "Team"}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></header>{message.kind === "decision" && <strong className="decision-label">Final trading decision</strong>}<p>{message.content}</p><footer><span>{message.status}</span> · <a href="#run-details" onClick={(event) => { event.preventDefault(); void perform(async () => { setRunDetail(await api(simulationPath(`/api/team/runs/${message.runId}`, simulationId))); requestAnimationFrame(() => document.getElementById("run-details")?.scrollIntoView({ block: "nearest" })); }); }}>View run</a></footer></article>)}</div>
    <form className="workflow-form chat-composer" onSubmit={(event) => { event.preventDefault(); void perform(send); }}><label>Message {selected?.name ?? "the team"}<textarea rows={3} maxLength={12000} value={draft} disabled={readonly} onChange={(event) => setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))}/></label><div className="control-actions"><button disabled={readonly || busy || !draft.trim() || selected?.enabled === false}>Send message</button><span className="control-summary">{readonly ? "Archived conversations are read-only." : activeRuns.length ? "Your message will be queued after current work." : "Messages cannot authorize trades."}</span></div></form></section>
    {editor && <AgentEditor key={editor === "new" ? "new" : editor.id} agent={editor === "new" ? null : editor} simulationId={simulationId} editable={editable} onClose={() => setEditor(null)} onSaved={() => void refresh()}/>}
    </div>{runDetail && <section className="panel team-runs" id="run-details" aria-label="Run details"><div className="panel-heading"><h2>{runDetail.run.kind} · {runDetail.run.status}</h2><button className="plain-button" onClick={() => setRunDetail(null)}>Close details</button></div><p className="control-summary">{runDetail.run.callCount} model calls · {runDetail.run.id}</p>{runDetail.run.error && <p className="form-error">{runDetail.run.error}</p>}{runDetail.turns.map((turn) => <p className="control-summary" key={turn.id}>{agents.find((agent) => agent.id === turn.agentId)?.name ?? "Agent"} · {turn.status}{turn.error ? ` · ${turn.error}` : ""}</p>)}</section>}<section className="panel team-runs"><div className="panel-heading"><h2>Team runs</h2></div>{!runs.length && <p className="empty">No runs yet</p>}{runs.map((run) => <article className="team-run" id={`run-${run.id}`} key={run.id}><div><strong>{run.kind === "trading" ? "Trading cycle" : "Conversation"} · {run.status}</strong><p className="control-summary">{new Date(run.createdAt).toLocaleString()} · {run.callCount ?? 0} calls · {run.id.slice(0, 8)}</p>{run.error && <p className="form-error">{run.error}</p>}{run.decisionId && <p className="control-summary">Decision {run.decisionId}</p>}</div>{!readonly && activeStatuses.includes(run.status) && <div className="control-actions"><button disabled={busy} onClick={() => void perform(() => sendControl(`/api/team/runs/${run.id}/cancel`, "POST", {}))}>Stop conversation</button></div>}</article>)}</section></>}
    </div></main>;
}
