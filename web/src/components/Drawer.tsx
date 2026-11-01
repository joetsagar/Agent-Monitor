import { useEffect, useRef } from "react";
import type { EventRow } from "../../../shared/types";
import { agentOf, sessionOf, useApp } from "../ctx";
import { useAgentEvents } from "../hooks";
import { clock, duration, fmtNum, NEEDS_YOU, pretty, relTime, useNow } from "../util";
import { CostText, FileRef, ModelText, ResultView, SourceBadge, StatusBadge } from "./common";
import { InteractionPanel } from "./InteractionPanel";

function EventDetail({ e }: { e: EventRow }) {
  const d = (e.detail ?? null) as Record<string, unknown> | null;
  const out = d ? (d.output ?? d.response) : undefined;
  return (
    <details className={`evrow ${e.status === "error" ? "ev-error" : ""}`}>
      <summary>
        <span className="mono muted">{clock(e.ts)}</span>{" "}
        {e.toolName && <span className="badge st-neutral">{e.toolName}</span>}{" "}
        {e.status === "error" && <span className="badge st-failed">Error</span>}{" "}
        <span className="mono">{e.summary}</span>
      </summary>
      {d == null ? <div className="muted small">No detail recorded for this event.</div> : (
        <div className="evdetail">
          {d.input !== undefined && <><div className="label">Input (redacted)</div><pre className="scroll">{pretty(d.input)}</pre></>}
          {out !== undefined && <><div className="label">Output</div><pre className="scroll">{pretty(out)}</pre></>}
          {d.error !== undefined && <><div className="label">Error</div><pre className="scroll err">{pretty(d.error)}</pre></>}
        </div>
      )}
    </details>
  );
}

export function Drawer({ agentId, interactionId, onClose }: { agentId: string; interactionId?: string; onClose: () => void }) {
  const { state, billingMode } = useApp();
  const now = useNow(1000);
  const ref = useRef<HTMLElement>(null);
  const agent = agentOf(state, agentId);
  const session = agent ? sessionOf(state, agent.sessionId) : undefined;
  const { events, loading, error } = useAgentEvents(agentId, true, 300);

  const prevFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (!interactionId) ref.current?.focus();
    const prev = prevFocus.current;
    // The opener may be gone (e.g. its Needs-you row disappeared once answered); fall back to main.
    return () => { if (prev?.isConnected) prev.focus(); else document.querySelector<HTMLElement>("main")?.focus(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes the drawer wherever focus is, not only inside it.
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab" || !ref.current) return;
    const f = Array.from(ref.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    )).filter((x) => x.offsetParent !== null);
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const interactions = state.interactions.filter((i) => i.agentId === agentId).sort((a, b) => a.createdAt - b.createdAt);
  const open = interactions.filter((i) => NEEDS_YOU.includes(i.status) || i.id === interactionId || i.status === "delivered" || now - i.updatedAt < 120_000);
  const rest = interactions.filter((i) => !open.includes(i));
  const tasks = state.tasks.filter((t) => t.agentId === agentId && t.status !== "deleted");
  const usage = state.usage.filter((u) => u.agentId === agentId || (agent?.role === "lead" && u.agentId === null && u.sessionId === agent.sessionId));
  const problems = events.filter((e) => e.summary.startsWith("Test command") || e.status === "error");

  return (
    <aside ref={ref} className="drawer" role="dialog" aria-modal="false" aria-label={`Details for ${agent?.name ?? "agent"}`} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="drawer-head">
        <h2>{agent ? agent.name : "Agent not found"} {agent && <span className="muted small">{agent.role}</span>}</h2>
        <button type="button" className="btn" onClick={onClose} aria-label="Close details (Esc)">Close</button>
      </header>
      {!agent && <div className="callout neutral">This agent is no longer in the monitor's data.</div>}
      {agent && (
        <div className="drawer-body">
          {open.map((i) => <InteractionPanel key={i.id} interaction={i} autoFocus={i.id === interactionId} />)}

          <section>
            <h3>Task brief</h3>
            {agent.assignedTask ? <pre className="scroll wrap">{agent.assignedTask}</pre> : <div className="muted">No task assigned.</div>}
            <div className="label">Checklist</div>
            {tasks.length === 0 ? <div className="muted small">No checklist reported by this agent.</div> : (
              <ul className="plain small">
                {tasks.map((t) => <li key={t.id}><span className="mono">[{t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : t.status === "blocked" ? "!" : " "}]</span> {t.title} <span className="muted">({t.status.replace("_", " ")})</span></li>)}
              </ul>
            )}
            {agent.subtasks && <div className="small">{agent.subtasks.completed} of {agent.subtasks.total} subtasks complete <span className="muted">(from {agent.subtasks.source})</span></div>}
          </section>

          <section>
            <h3>State</h3>
            <StatusBadge agent={agent} now={now} />
            <div className="small">Now: <span className="mono">{agent.currentAction ?? "—"}</span></div>
            <div className="small muted">Last activity {relTime(agent.lastActivityAt, now)} · started {clock(agent.startedAt)} · elapsed {duration((agent.endedAt ?? now) - agent.startedAt)}</div>
            <div className="small">Model: <ModelText model={agent.model} />{agent.modelSource && <span className="muted"> (source: {agent.modelSource})</span>}</div>
            {agent.lastResult && <ResultView result={agent.lastResult} maxHeight={240} />}
          </section>

          <section>
            <h3>Changed files</h3>
            {agent.changedFiles.length === 0 ? <div className="muted small">None reported.</div> : (
              <ul className="plain mono small">
                {agent.changedFiles.map((f) => <li key={f}><FileRef path={f} cwd={session?.cwd} /></li>)}
              </ul>
            )}
          </section>

          <section>
            <h3>Test results and errors</h3>
            {problems.length === 0 ? <div className="muted small">None recorded.</div> : (
              <div>{problems.map((e) => <EventDetail key={e.id} e={e} />)}</div>
            )}
          </section>

          <section>
            <h3>Tool events {loading && <span className="muted small">loading…</span>}</h3>
            {error && <div className="callout failed small">Could not load events: {error}</div>}
            {events.length === 0 && !loading && !error && <div className="muted small">No events.</div>}
            <div className="evbox">{events.map((e) => <EventDetail key={e.id} e={e} />)}</div>
          </section>

          <section>
            <h3>Usage</h3>
            {usage.length === 0 ? <div className="muted small">Unknown — no usage records.</div> : (
              <ul className="plain small">
                {usage.map((u) => (
                  <li key={u.id} className="usage-rec">
                    <div className="mono">in {fmtNum(u.inputTokens)} · out {fmtNum(u.outputTokens)} · cache read {fmtNum(u.cacheReadTokens)} · cache write {fmtNum(u.cacheCreationTokens)}</div>
                    <div><CostText cost={u.costEstimateUsd} basis={u.costBasis} billingMode={billingMode} /></div>
                    <div className="muted">{u.sourceNote} · model: {u.model ?? "Unknown"}{u.includedInParent && " · included in session total"}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {rest.length > 0 && (
            <section>
              <h3>Earlier requests ({rest.length})</h3>
              {rest.map((i) => <details key={i.id}><summary>{i.kind} — {i.status}</summary><InteractionPanel interaction={i} /></details>)}
            </section>
          )}

          <section>
            <h3>Session</h3>
            {session ? (
              <dl className="kv small">
                <dt>Title</dt><dd>{session.title}</dd>
                <dt>Source</dt><dd><SourceBadge session={session} /></dd>
                <dt>Runtime session</dt><dd className="mono">{session.runtimeSessionId ?? "Unknown"}</dd>
                <dt>Auth source</dt><dd>{session.authSource ?? "Unknown"}</dd>
                <dt>Runtime</dt><dd>{session.source === "codex-local" ? "Codex (local observation)" : `Claude Code ${session.claudeCodeVersion ?? "Unknown version"}`}</dd>
                <dt>Permission mode</dt><dd>{session.permissionMode ?? "Unknown"}</dd>
                <dt>Working dir</dt><dd className="mono">{session.cwd}</dd>
              </dl>
            ) : <div className="muted">Unknown session.</div>}
          </section>
        </div>
      )}
    </aside>
  );
}
