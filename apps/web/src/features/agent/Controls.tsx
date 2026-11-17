import { useState } from "react";
import type { HealthData, SettingsData } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";

export function Controls({ health, settings, onRefresh }: { health: HealthData | null; settings: SettingsData | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const state = health?.agent;
  const providerReady = settings?.values.provider === "codex" ? false : health?.providers.grok === "configured";
  const run = async (kind: "start" | "pause" | "run-once") => {
    setBusy(true); setError(""); setMessage("");
    try {
      if (kind === "start") { await sendControl("/api/agent/start", "POST", {}); setMessage("Agent started. The first scheduled decision waits for the configured cadence."); }
      if (kind === "pause") { await sendControl("/api/agent/pause", "POST", { reason: "manual" }); setMessage("Agent paused. Market and portfolio updates continue."); }
      if (kind === "run-once") { const result = await sendControl<{ requestId: string; status: string }>("/api/agent/run-once", "POST", { requestId: crypto.randomUUID() }); setMessage(`Decision ${result.requestId} accepted and running.`); }
      onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Control request failed"); }
    finally { setBusy(false); }
  };
  return <section className="panel workflow-panel" id="agent-controls" aria-labelledby="agent-controls-heading"><div className="panel-heading"><div><p className="eyebrow">LIFECYCLE</p><h2 id="agent-controls-heading">Agent controls</h2></div><span className={`agent-state ${state?.paused ? "paused" : "running"}`}>{state?.paused ? "PAUSED" : "RUNNING"}</span></div><div className="control-actions"><button disabled={busy || !state?.paused || !providerReady} onClick={() => void run("start")}>{state?.pauseReason === "daily_loss_limit" ? "Resume agent" : "Start agent"}</button><button className="button-secondary" disabled={busy || !state || state.paused} onClick={() => void run("pause")}>Pause</button><button className="button-secondary" disabled={busy || !state?.paused || !providerReady || state.cycleRunning} onClick={() => void run("run-once")}>Run once</button></div><p className="control-summary">{state?.cycleRunning ? "A decision is in progress." : state?.paused ? `Paused${state.pauseReason ? ` · ${state.pauseReason.replaceAll("_", " ")}` : ""}.` : `Next decision uses a ${settings?.values.cadenceSeconds ?? "—"}-second cadence.`} Daily attempts: {health?.usage.dailyAttempts ?? 0}/300.</p>{!providerReady && <p className="readiness-help">{settings?.values.provider === "codex" ? "Codex is disabled because this CLI cannot prove tool isolation." : "Grok is not ready. Add XAI_API_KEY to the server environment and restart it."}</p>}{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}</section>;
}
