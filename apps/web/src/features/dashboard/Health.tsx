import type { HealthData, SettingsData } from "../../lib/api.js";

export function Health({ health, settings, updatedAt }: { health: HealthData | null; settings: SettingsData | null; updatedAt: Date | null }) {
  const activeProvider = settings?.values.provider === "codex" ? "Codex · disabled" : health?.providers.grok === "configured" ? "Grok · configured" : "Grok · missing key";
  return <section className="panel health-panel" aria-labelledby="health-heading"><div className="panel-heading"><div><p className="eyebrow">SYSTEM STATUS</p><h2 id="health-heading">Health & freshness</h2></div></div><ul className="health-list"><HealthItem label="Database" value={health?.database ?? "loading"}/><HealthItem label="Binance market" value={health?.market ?? "loading"}/><HealthItem label="Decision provider" value={settings ? activeProvider : "loading"}/><HealthItem label="Portfolio data" value={updatedAt ? `updated ${updatedAt.toLocaleTimeString()}` : "awaiting data"}/><HealthItem label="AI attempts" value={`${health?.usage.dailyAttempts ?? 0} / 300 today`}/></ul><div className="provider-detail"><span className="eyebrow">ACTIVE MODEL</span><strong>{settings ? `${settings.values.provider} / ${settings.values.model}` : "Not configured"}</strong><span className="muted">API usage is separate from simulated funds. If database is unavailable, start Docker with pnpm db:up.</span></div></section>;
}

function HealthItem({ label, value }: { label: string; value: string }) {
  const tone = value.includes("healthy") || value.includes("available") || value.includes("updated") ? "good" : value.includes("stale") || value.includes("degraded") ? "warn" : "dim";
  return <li><span className={`status-mark ${tone}`} aria-hidden="true"/><span>{label}</span><strong>{value}</strong></li>;
}
