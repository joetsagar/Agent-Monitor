import { ProviderLogo } from "./ProviderLogo";
import { useEffect, useState } from "react";
import type { WidgetUsageSnapshot, WidgetUsageProvider, WidgetUsageRow } from "../../../shared/types";
import { fetchWidgetUsage, refreshWidgetUsage } from "../api";
import { useApp } from "../ctx";
import { useNow } from "../util";
import { setExchangeRate } from "../currency";

function resetLabel(value: string | null, now: number): string {
  if (!value) return "Reset time unavailable";
  const reset = Date.parse(value);
  if (!Number.isFinite(reset)) return "Reset time unavailable";
  const remaining = Math.max(0, reset - now);
  if (remaining === 0) return "Reset due";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `Resets in ${hours ? `${hours}h ` : ""}${minutes}m`;
}

function UsageRow({ row, stale, now, showCredits }: { row: WidgetUsageRow; stale: boolean; now: number; showCredits: boolean }) {
  const percent = typeof row.percent === "number" && Number.isFinite(row.percent) ? Math.max(0, Math.min(100, row.percent)) : null;
  const reset = row.resetsAt ? Date.parse(row.resetsAt) : NaN;
  const elapsed = row.windowSeconds && Number.isFinite(reset)
    ? Math.max(0, Math.min(100, (now - (reset - row.windowSeconds * 1000)) / (row.windowSeconds * 1000) * 100)) : null;
  const tone = percent != null && percent >= 90 ? "critical" : percent != null && percent >= 75 ? "warning" : "normal";
  return <div className={`usage-window ${stale ? "stale-data" : ""}`}>
    <div className="usage-window-heading"><span>{row.label}</span>
      <strong className={`usage-value ${tone}`}>{percent != null ? `${Math.round(percent)}% used` : row.tokens != null ? row.tokens.toLocaleString() : "Unknown"}</strong>
    </div>
    {percent != null && <div className={`usage-track ${tone}`} role="progressbar" aria-label={`${row.label} used${stale ? " (last known)" : ""}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="usage-fill" style={{ width: `${percent}%` }} />
      {elapsed != null && <span className="usage-pace" style={{ left: `${elapsed}%` }} title={`${Math.round(elapsed)}% of the time window elapsed`} aria-hidden="true" />}
    </div>}
    {percent != null && <div className="usage-reset muted" title={row.resetsAt ? new Date(row.resetsAt).toLocaleString() : undefined}>{resetLabel(row.resetsAt, now)}</div>}
    {row.tokens != null && percent == null && <div className="usage-reset muted">tokens over the last 7 days</div>}
    {showCredits && <div className="usage-credits" title="Prepaid usage-credit balance. GBP equivalent uses the reference rate shown below.">
      {row.credits != null ? <>Credits: £{row.credits.toFixed(2)}{(stale || row.creditsStale) && <span className="muted"> (last known)</span>}</> : "Credits: unavailable"}
    </div>}
  </div>;
}

function Provider({ provider, now }: { provider: WidgetUsageProvider; now: number }) {
  return <section className={`usage-provider provider-${provider.id}`} aria-label={`${provider.name} usage`}>
    <div className="usage-provider-heading"><h3><ProviderLogo id={provider.id} />{provider.name}</h3>{provider.stale && <span className="usage-state">Last known</span>}</div>
    {provider.rows.map((row, index) => <UsageRow key={`${row.label}-${index}`} row={row} stale={provider.stale} now={now} showCredits={provider.id === "claude" && row.label === "Weekly (7 days)"} />)}
    {provider.status === "loading" && <p className="usage-message muted">Reading usage…</p>}
    {provider.status === "ok" && provider.rows.length === 0 && <p className="usage-message muted">No usage windows reported.</p>}
    {provider.error && <p className="usage-message usage-error" role="status">{provider.error}</p>}
  </section>;
}

function demoSnapshot(): WidgetUsageSnapshot {
  const now = Date.now();
  const row = (label: string, percent: number, windowSeconds: number, remainingSeconds: number): WidgetUsageRow => ({ label, percent, tokens: null, credits: null, windowSeconds, resetsAt: new Date(now + remainingSeconds * 1000).toISOString() });
  return { updatedAt: now, refreshing: false, exchangeRate: { usdToGbp: 0.75, asOf: "2026-11-01" }, providers: [
    { id: "claude", name: "Claude", status: "ok", error: null, stale: false, rows: [row("Session (5 hours)", 34, 18000, 9000), { ...row("Weekly (7 days)", 61, 604800, 300000), credits: 12.34 }] },
    { id: "codex", name: "Codex", status: "ok", error: null, stale: false, rows: [row("Session (5 hours)", 18, 18000, 12000), row("Weekly (7 days)", 42, 604800, 380000)] },
    { id: "kilo", name: "Kilo Code", status: "ok", error: null, stale: false, rows: [{ label: "Tokens (7 days)", tokens: 1284500, credits: null, percent: null, resetsAt: null, windowSeconds: 604800 }] },
  ] };
}

export function UsageSidebar() {
  const { boot, demo } = useApp();
  const [snapshot, setSnapshot] = useState<WidgetUsageSnapshot | null>(() => demo ? demoSnapshot() : null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const now = useNow(30_000);
  useEffect(() => { if (snapshot?.exchangeRate) setExchangeRate(snapshot.exchangeRate); }, [snapshot?.exchangeRate]);
  useEffect(() => {
    if (demo || !boot) return;
    let cancelled = false;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try { const next = await fetchWidgetUsage(); if (!cancelled) { setSnapshot(next); setError(null); } }
      catch { if (!cancelled) setError("Usage connection unavailable. Retrying."); }
      finally { pending = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [boot, demo]);

  const refresh = async () => {
    if (demo) { setSnapshot(demoSnapshot()); return; }
    setSending(true);
    try { setSnapshot(await refreshWidgetUsage()); setError(null); }
    catch { setError("Couldn't refresh usage. Retrying automatically."); }
    finally { setSending(false); }
  };

  return <aside className="usage-sidebar" aria-label="AI Usage widget">
    <header className="usage-sidebar-heading"><div><h2>AI Usage</h2><span className="small muted">{demo ? "Simulated account limits" : "Account limits"}</span></div>
      <button type="button" className="btn small" onClick={() => void refresh()} disabled={!boot || sending || snapshot?.refreshing}>{sending || snapshot?.refreshing ? "Refreshing" : "Refresh"}</button>
    </header>
    <div className="usage-sidebar-body">
      {!snapshot && <p className="usage-message muted">Connecting to Usage-Widget…</p>}
      {snapshot?.providers.map((provider) => <Provider key={provider.id} provider={provider} now={now} />)}
      {error && <p className="usage-message usage-error" role="status">{error}</p>}
    </div>
    <footer className="usage-sidebar-footer muted">
      <span>{snapshot?.exchangeRate ? `GBP reference rate · ${snapshot.exchangeRate.asOf}${demo ? " (demo)" : ""}` : "GBP conversion unavailable"}</span>
      <span className="usage-legend"><span aria-hidden="true">│</span> Time elapsed in each window</span>
      <span>{snapshot?.updatedAt ? `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Usage refreshes every 2 minutes"}</span>
      {snapshot?.updatedAt && <span>Refreshes every 2 minutes</span>}
    </footer>
  </aside>;
}
