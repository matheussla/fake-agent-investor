import type { HealthData, SettingsData } from "../../lib/api.js";

export function UsageMeter({ health, settings, stale }: { health: HealthData | null; settings: SettingsData | null; stale: boolean }) {
  const attempts = health?.usage.dailyAttempts;
  const limit = settings?.values.dailyAttemptLimit;
  const available = typeof attempts === "number" && Number.isFinite(attempts) && attempts >= 0 && typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const percent = available ? Math.min(100, attempts / limit * 100) : null;
  const exhausted = available && attempts >= Math.ceil(limit * 0.95);
  return <section className="panel usage-meter" aria-labelledby="usage-heading">
    <div className="panel-heading"><div><p className="eyebrow">API USAGE · TODAY</p><h2 id="usage-heading">Daily platform call allowance</h2></div><strong>{percent === null ? "Unavailable" : `${Number(percent.toFixed(1))}% used`}</strong></div>
    {percent !== null && <progress aria-label="Daily platform call allowance" max={100} value={percent}/>}
    <p className="control-summary">{available ? `${attempts} / ${limit} calls · ${Math.max(0, Math.ceil(limit * 0.95) - attempts)} remaining before automatic stop` : "Waiting for usage data…"}{stale ? " · Last known usage; reconnecting…" : ""}</p>
    {health?.usage.providers?.codex !== undefined && <p className="control-summary">OpenAI / Codex: {health.usage.providers.codex} calls today.</p>}
    <p className="control-summary">Shared across this platform’s agents, simulations, and providers. Includes failed attempts. Resets daily at 00:00 UTC.</p>
    <p className="control-summary">Automatic stop at 95% of this app budget. OpenAI billing and Codex subscription quotas are not included.</p>
    {exhausted && <p className="form-error" role="status">95% usage cutoff reached. Increase the app budget or wait for the UTC reset before restarting.</p>}
  </section>;
}
