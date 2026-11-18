import { useEffect, useState } from "react";
import type { HealthData, SettingsData } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";
import { runOnce } from "../../lib/run-once.js";

export function Controls({ health, settings, onRefresh, dashboard = false, unavailable = false }: { dashboard?: boolean; unavailable?: boolean; health: HealthData | null; settings: SettingsData | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const state = health?.agent;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!dashboard) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [dashboard]);
  const timing = health?.cycleTiming;
  const controlsId = dashboard ? "dashboard-cycle" : "agent-controls";
  const duration = (milliseconds: number) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const status = unavailable || !state ? "UNKNOWN" : state.cycleRunning || !state.paused ? "RUNNING" : "PAUSED";
  const providerReady = settings?.values.provider === "codex" ? health?.providers.codex === "configured" : health?.providers.grok === "configured";
  const run = async (kind: "start" | "pause" | "stop" | "run-once") => {
    setBusy(true); setError(""); setMessage("");
    try {
      if (kind === "start") { await sendControl("/api/agent/start", "POST", {}); setMessage("Continuous trading started. Evaluations repeat until stopped or the usage cutoff is reached."); }
      if (kind === "pause" || kind === "stop") { await sendControl("/api/agent/pause", "POST", { reason: "manual" }); setMessage("Agent paused. Any active cycle was cancelled. Market and portfolio updates continue."); }
      if (kind === "run-once") { const result = await runOnce(health?.simulation?.id ?? ""); setMessage(`Decision ${result.requestId} accepted and running.`); }
      onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Control request failed"); }
    finally { setBusy(false); }
  };
  return <section className="panel workflow-panel" id={controlsId} aria-labelledby={`${controlsId}-heading`}><div className="panel-heading"><div><p className="eyebrow">LIFECYCLE</p><h2 id={`${controlsId}-heading`}>{dashboard ? "Trading cycle" : "Agent controls"}</h2></div><span className={`agent-state ${state?.paused ? "paused" : "running"}`}>{status}</span></div><div className="control-actions"><button disabled={unavailable || busy || !state?.paused || !providerReady || state.cycleRunning} onClick={() => void run("start")}>{state?.pauseReason === "daily_loss_limit" ? "Resume agent" : "Start agent"}</button><button className="button-secondary" disabled={unavailable || busy || !state || (state.paused && !state.cycleRunning)} onClick={() => void run("pause")}>Pause</button><button className="button-secondary" disabled={unavailable || busy || !state?.paused || !providerReady || state.cycleRunning} onClick={() => void run("run-once")}>Run once</button>{dashboard && <button className="button-secondary" disabled={unavailable || busy || (!state || (state.paused && !state.cycleRunning))} onClick={() => void run("stop")}>Stop cycle</button>}</div>
    {dashboard && <div className="cycle-timing">
      <strong>{unavailable ? "Reconnecting to session status…" : `Session elapsed ${timing?.sessionStartedAt ? duration((timing.sessionStoppedAt ? Date.parse(timing.sessionStoppedAt) : now) - Date.parse(timing.sessionStartedAt)) : "0:00"}`}</strong>
      <span>{state?.paused && !state.cycleRunning ? "Session paused" : state?.cycleRunning ? "Evaluating markets and executing qualifying trades" : "Preparing next evaluation"}</span>
      {timing?.sessionStartedAt && <span>Started: {new Date(timing.sessionStartedAt).toLocaleTimeString()}</span>}
      {timing?.sessionStoppedAt && <span>Stopped: {new Date(timing.sessionStoppedAt).toLocaleTimeString()}</span>}
      <span>Automatic stop at 95% of the app call budget</span>
    </div>}
    <p className="control-summary">{state?.cycleRunning ? "A decision is in progress." : state?.paused ? `Paused${state.pauseReason ? ` · ${state.pauseReason.replaceAll("_", " ")}` : ""}.` : "Continuous session active. No delay between completed evaluations."} Daily attempts: {health?.usage.dailyAttempts ?? 0}/{settings?.values.dailyAttemptLimit ?? 300}.</p>{!providerReady && <p className="readiness-help">{settings?.values.provider === "codex" ? "Codex is not ready. Add OPENAI_API_KEY to the server environment and restart it." : "Grok is not ready. Add XAI_API_KEY to the server environment and restart it."}</p>}{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}</section>;
}
