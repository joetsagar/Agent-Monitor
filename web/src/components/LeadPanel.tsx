import { useState } from "react";
import type { Agent, EventRow } from "../../../shared/types";
import { cancelSession, endSession, sendSessionMessage } from "../api";
import { inScope, sessionOf, useApp } from "../ctx";
import type { Scope } from "../ctx";
import { useAgentEvents } from "../hooks";
import { isDemoId } from "../demo";
import { clock, NEEDS_YOU, relTime, useNow } from "../util";
import { ModelText, SourceBadge, StatusBadge } from "./common";

export function EventList({ events }: { events: EventRow[] }) {
  return (
    <ul className="plain evlist mono small">
      {events.map((e) => (
        <li key={e.id} className={e.status === "error" ? "ev-error" : ""}>
          <span className="muted">{clock(e.ts)}</span>{" "}
          {e.status === "error" && <span className="badge st-failed">Error</span>} {e.summary}
        </li>
      ))}
    </ul>
  );
}

function History({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const { events, loading, error } = useAgentEvents(agent.id, open, 100);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Activity history</summary>
      {loading && events.length === 0 && <div className="muted small">Loading…</div>}
      {error && <div className="callout failed small">Could not load events: {error}</div>}
      <div className="scroll tall"><EventList events={events} /></div>
    </details>
  );
}

export function LeadPanel({ scope }: { scope: Scope }) {
  const { state, demo } = useApp();
  const now = useNow(1000);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const leads = inScope(state.agents, scope).filter((a) => a.role === "lead");
  const lead = leads.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (!lead) {
    return <section className="panel"><h2>Lead</h2><div className="muted">No lead agent in this scope yet.</div></section>;
  }
  const session = sessionOf(state, lead.sessionId);
  const plan = state.tasks.filter((t) => t.agentId === lead.id && t.status !== "deleted");
  const titleOf = (id: string) => state.tasks.find((t) => t.id === id)?.title ?? id;
  const blockedTasks = state.tasks.filter((t) => t.sessionId === lead.sessionId && t.status === "blocked");
  const failedAgents = state.agents.filter((a) => a.sessionId === lead.sessionId && a.status === "failed");
  const pending = state.interactions.filter((i) => i.sessionId === lead.sessionId && NEEDS_YOU.includes(i.status));
  const managed = session?.source === "managed";
  const live = session && !["ended", "cancelled", "failed"].includes(session.runtimeState);
  const simulated = isDemoId(lead.id);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { if (simulated) { await new Promise((r) => setTimeout(r, 400)); } else await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="panel" aria-labelledby="lead-h">
      <h2 id="lead-h">Lead</h2>
      <div className="lead-grid">
        <div>
          <div className="lead-name"><strong>{lead.name}</strong> <SourceBadge session={session} /></div>
          <div className="small">Session: {session?.title ?? "Unknown"}</div>
          <div className="small">Model: <ModelText model={lead.model ?? session?.model ?? null} /></div>
          <div className="small">
            Runtime: <span className="mono">{session?.runtimeState ?? "unknown"}</span>
            {session?.runtimeStateDetail && <span className="muted"> — {session.runtimeStateDetail}</span>}
          </div>
          <StatusBadge agent={lead} now={now} />
          <div className="small">Now: <span className="mono">{lead.currentAction ?? "—"}</span> <span className="muted">({relTime(lead.lastActivityAt, now)})</span></div>
        </div>

        <div>
          <div className="label">Plan {plan.length > 0 && <span className="muted small">({plan[0].source})</span>}</div>
          {plan.length === 0 ? <div className="muted small">The lead has not defined a plan (no tasks reported).</div> : (
            <ul className="plain small">
              {plan.map((t) => (
                <li key={t.id}>
                  <span className={`badge ${t.status === "completed" ? "st-ok" : t.status === "blocked" ? "st-attention" : "st-neutral"}`}>
                    {t.status === "in_progress" ? "In progress" : t.status === "completed" ? "Done" : t.status === "blocked" ? "Blocked" : "Pending"}
                  </span>{" "}
                  {t.title}
                  {t.blockedBy.length > 0 && <span className="muted"> — blocked by: {t.blockedBy.map(titleOf).join(", ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="label">Blockers</div>
          {blockedTasks.length + failedAgents.length + pending.length === 0 ? <div className="muted small">None reported.</div> : (
            <ul className="plain small">
              {blockedTasks.map((t) => <li key={t.id}><span className="badge st-attention">Task blocked</span> {t.title}</li>)}
              {failedAgents.map((a) => <li key={a.id}><span className="badge st-failed">Agent failed</span> {a.name}</li>)}
              {pending.map((i) => <li key={i.id}><span className="badge st-attention">Waiting on you</span> {i.kind} request ({i.status})</li>)}
            </ul>
          )}
        </div>
      </div>

      <History agent={lead} />

      {managed && (
        <div className="lead-controls">
          <label className="other">
            <span className="small muted">Send a follow-up message to this session{demo && simulated ? " (simulated)" : ""}</span>
            <textarea rows={2} value={msg} disabled={busy || !live || !session?.capabilities.sendMessages} onChange={(e) => setMsg(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy || !msg.trim() || !live || !session?.capabilities.sendMessages}
              onClick={() => run(async () => { await sendSessionMessage(lead.sessionId, msg.trim()); setMsg(""); })}>Send message</button>
            {!confirmCancel ? (
              <button type="button" className="btn" disabled={busy || !live || !session?.capabilities.cancel} onClick={() => setConfirmCancel(true)}>Cancel current turn</button>
            ) : (
              <span className="confirm" role="group" aria-label="Confirm cancel">
                Cancel the running turn?
                <button type="button" className="btn danger" disabled={busy} onClick={() => { setConfirmCancel(false); run(() => cancelSession(lead.sessionId)); }}>Yes, cancel</button>
                <button type="button" className="btn" onClick={() => setConfirmCancel(false)}>Keep running</button>
              </span>
            )}
            <button type="button" className="btn" disabled={busy || !live} onClick={() => run(() => endSession(lead.sessionId))}>End session</button>
          </div>
          {!live && <div className="muted small">Session is not running ({session?.runtimeState}); controls are disabled.</div>}
          {err && <div className="callout failed" role="alert">{err}</div>}
        </div>
      )}
      {!managed && <div className="muted small">{session?.source === "kilo-local" ? "Observed from local Kilo CLI database: interact with this session in Kilo." : session?.source === "codex-local" ? "Observed from local Codex logs: interact with this session in Codex." : "Observed via VS Code hooks: interact with this session in VS Code."}</div>}
    </section>
  );
}
