import { useEffect, useState } from "react";
import type { HealthData, PortfolioData, SettingsData } from "../../lib/api.js";
import { sendControl } from "../../lib/control.js";

export function Settings({ settings, health, portfolio, onRefresh }: { settings: SettingsData | null; health: HealthData | null; portfolio: PortfolioData | null; onRefresh: () => void }) {
  const [values, setValues] = useState<SettingsData["values"] | null>(settings?.values ?? null);
  const [assetsText, setAssetsText] = useState(settings?.values.assets.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { if (settings) { setValues(settings.values); setAssetsText(settings.values.assets.join(", ")); } }, [settings]);
  if (!settings || !values) return <section className="panel workflow-panel" id="settings"><h2>Settings unavailable</h2><p>Load simulation settings before making changes.</p></section>;
  const paused = !!health?.agent?.paused && !health.agent.cycleRunning;
  const held = portfolio?.positions.map((position) => position.symbol) ?? [];
  const update = (key: keyof SettingsData["values"], value: string | number) => setValues((current) => current ? { ...current, [key]: value } : current);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const assets = assetsText.split(",").map((asset) => asset.trim().toUpperCase()).filter(Boolean);
    try {
      const result = await sendControl<SettingsData>("/api/settings", "PATCH", { expectedVersion: settings.version, values: { ...values, assets } });
      setMessage(`Saved configuration version ${result.version}. Positions and simulated balances are unchanged.`); onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings could not be saved"); }
    finally { setBusy(false); }
  };
  return <section className="panel workflow-panel" id="settings" aria-labelledby="settings-heading"><div className="panel-heading"><div><p className="eyebrow">CONFIGURATION</p><h2 id="settings-heading">Strategy settings</h2></div><span className="muted">Version {settings.version}</span></div><p className="control-summary">Settings can change only while the agent is paused and idle. Switching provider preserves all positions, history, and balances.</p><p className="readiness-help">{held.length ? `Held assets stay enabled: ${held.join(", ")}. ` : "No held assets. "}{values.provider === "codex" ? "Codex remains unavailable until tool isolation is supported." : health?.providers.grok === "configured" ? "Grok credentials are configured on the server." : "Set XAI_API_KEY on the server to enable Grok decisions."}</p><form onSubmit={(event) => void save(event)} className="workflow-form settings-form"><label>Decision provider<select value={values.provider} onChange={(event) => update("provider", event.target.value)}><option value="grok">Grok</option><option value="codex">Codex CLI</option></select></label><label>Model<input required maxLength={100} value={values.model} onChange={(event) => update("model", event.target.value)}/></label><label>Markets<input required value={assetsText} onChange={(event) => setAssetsText(event.target.value)} aria-describedby="assets-help"/></label><p className="field-help" id="assets-help">Comma-separated USDT spot symbols. Held assets cannot be removed.</p><label>Decision cadence (seconds)<input required type="number" min={60} max={86400} value={values.cadenceSeconds} onChange={(event) => update("cadenceSeconds", Number(event.target.value))}/></label><label>Fee rate<input required inputMode="decimal" value={values.feeRate} onChange={(event) => update("feeRate", event.target.value)}/></label><label>Slippage (basis points)<input required type="number" min={0} max={500} value={values.slippageBps} onChange={(event) => update("slippageBps", Number(event.target.value))}/></label><label>Max buy size<input required inputMode="decimal" value={values.maximumBuyPercent} onChange={(event) => update("maximumBuyPercent", event.target.value)}/></label><label>Max asset exposure<input required inputMode="decimal" value={values.maximumAssetExposure} onChange={(event) => update("maximumAssetExposure", event.target.value)}/></label><label>Max total exposure<input required inputMode="decimal" value={values.maximumTotalExposure} onChange={(event) => update("maximumTotalExposure", event.target.value)}/></label><label>Daily loss limit<input required inputMode="decimal" value={values.dailyLossLimit} onChange={(event) => update("dailyLossLimit", event.target.value)}/></label><button disabled={busy || !paused}>{busy ? "Saving…" : paused ? "Save settings" : "Pause agent to edit"}</button></form>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}</section>;
}
