import { useMemo } from "react";
import { useExchangeRate } from "../currency";
import type { Agent, EventRow, Session, UsageRecord } from "../../../shared/types";
import { inScope, sessionOf, useApp } from "../ctx";
import type { Scope } from "../ctx";
import { useAgentEvents } from "../hooks";
import { ProviderLogo } from "./ProviderLogo";
import { duration, fmtCost, minutesSince, NEEDS_YOU, stableSort, sumUsage, useNow } from "../util";

// Stacked terminal view: one block per session, the lead pane full width on
// top and its workers two-up underneath. Every line comes from a recorded
// event; the status line shows the real runtime state, never invented words.

const RECENT_MS = 15 * 60_000;

const readableSummary = (text: string) => text.replace(/(?:…|\.\.\.)(\s*\(agent-reported[^)]*\))?$/, " [stored summary shortened]");
const workerTitle = (agent: Agent) => {
  if (agent.name && !["general-purpose", "worker", "subagent"].includes(agent.name)) return agent.name;
  if (!["general-purpose", "worker", "subagent"].includes(agent.role)) return agent.role;
  return agent.assignedTask?.trim() ? readableSummary(agent.assignedTask.trim()) : "Worker";
};

type Tone = "ok" | "error" | "pending" | "info" | "attention";
interface Line { key: string; tone: Tone; tool?: string; arg?: string; text?: string; result?: { text: string; tone: Tone } }

const VERB = /^(\$ |Read |Write |Edit notebook |Edit |Glob |Grep |Fetch |Search |Delegate: )/;
const argOf = (summary: string) => summary.replace(VERB, "");

function toLines(events: EventRow[]): Line[] {
  const lines: Line[] = [];
  const byTool = new Map<string, Line>();
  for (const original of events) {
    const detail = original.detail as { text?: string; input?: Record<string, unknown> } | undefined;
    const input = detail?.input;
    const arg = input && (input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description);
    const e = { ...original, summary: typeof detail?.text === "string" ? detail.text : original.summary };
    const k = e.toolUseId;
    if (e.kind === "tool_start" && e.toolName) {
      const l: Line = { key: `e${e.id}`, tone: "pending", tool: e.toolName,
        arg: e.toolName === "exec" && e.summary.startsWith("Run tools:") ? e.summary : typeof arg === "string" ? arg : argOf(e.summary) };
      if (k) byTool.set(k, l);
      lines.push(l);
    } else if ((e.kind === "tool_end" || e.kind === "tool_fail") && e.toolName) {
      let l = k ? byTool.get(k) : undefined;
      if (!l) { l = { key: `e${e.id}`, tone: "pending", tool: e.toolName, arg: argOf(e.summary.replace(/^Failed: /, "").split(" — ")[0]) }; lines.push(l); }
      if (e.kind === "tool_fail") {
        l.tone = "error";
        l.result = { text: `failed: ${e.summary.includes(" — ") ? e.summary.split(" — ").slice(1).join(" — ") : e.summary}`, tone: "error" };
      } else {
        l.tone = "ok";
        if (/^Test command passed/.test(e.summary)) l.result = { text: "tests passed (exit 0)", tone: "ok" };
      }
    } else if (e.kind === "permission_request" || e.kind === "question") {
      lines.push({ key: `e${e.id}`, tone: "attention", text: e.summary });
    } else if (e.kind === "turn_end" && lines.length && lines[lines.length - 1].tone === "info" && !lines[lines.length - 1].tool) {
      // The turn result repeats the agent's last message; don't show it twice.
      continue;
    } else if (!QUIET.has(e.kind) && e.kind !== "tool_start") {
      lines.push({ key: `e${e.id}`, tone: e.status === "error" ? "error" : "info", text: e.summary.replace(/ \(agent-reported\)$/, "") });
    }
  }
  return lines;
}

// Lifecycle bookkeeping that the pane's header and status line already convey.
const QUIET = new Set(["marker", "init", "session_start", "prompt", "notification", "resume"]);

const BULLET: Record<Tone, { glyph: string; label: string }> = {
  ok: { glyph: "●", label: "succeeded" },
  error: { glyph: "●", label: "failed" },
  pending: { glyph: "◌", label: "running" },
  attention: { glyph: "◐", label: "needs you" },
  info: { glyph: "", label: "" },
};

function StatusLine({ agent, tokens, now, isLead }: { agent: Agent; tokens: number | null; now: number; isLead: boolean }) {
  const map: Record<Agent["status"], [string, string, string]> = {
    working: ["✻", "Working", "stk-accent"],
    waiting: ["◐", "Waiting for you", "stk-amber"],
    blocked: ["◐", "Blocked", "stk-amber"],
    idle: ["○", "Idle", "stk-dim"],
    failed: ["✕", "Failed", "stk-red"],
    completed: ["✓", "Completed", "stk-green"],
    cancelled: ["○", "Cancelled", "stk-dim"],
  };
  const [glyph, label, cls] = map[agent.status];
  const elapsed = duration((agent.endedAt ?? now) - agent.startedAt);
  const tok = tokens != null ? `↓ ${fmtTokens(tokens)}${isLead ? " tokens" : ""}` : null;
  const detail = isLead ? [elapsed, tok].filter(Boolean).join(" · ") : tok ?? elapsed;
  return (
    <div className="stk-status">
      {!isLead && <span className={cls} aria-hidden="true">{glyph} </span>}
      <span className={cls}>{label}</span>
      {agent.stale && <span className="stk-amber"> stale {minutesSince(agent.lastActivityAt, now)}m</span>}
      <span className="stk-dim" title="Tokens consumed as reported by the runtime or transcript (consumption, not progress)"> ({detail})</span>
    </div>
  );
}

function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function family(model: string | null): string | null {
  if (!model) return null;
  const m = model.match(/claude-([a-z]+)/i);
  return m ? m[1].toLowerCase() : model;
}

function Pane({ agent, name, isLead, workerCount, tokens, now, side, maxItems }: {
  agent: Agent; name: string; isLead: boolean; workerCount: number; tokens: number | null; now: number;
  side: "full" | "left" | "right"; maxItems: number;
}) {
  const { openDrawer, state } = useApp();
  const source = String(sessionOf(state, agent.sessionId)?.source ?? "");
  // Identify the agent runtime first: model names can be shared by providers.
  const brand = source.includes("kilo") ? "kilo" : source === "codex-local" ? "codex"
    : source === "managed" || source === "vscode-hooks" ? "claude"
    : agent.model?.startsWith("claude-") ? "claude" : "unknown";
  const { events, error } = useAgentEvents(agent.id, true, 60);
  const lines = useMemo(() => toLines(events.slice().reverse()).slice(-maxItems), [events, maxItems]);
  const fam = family(agent.model);
  return (
    <section className={`stk-pane ${side}${isLead ? " lead" : ""}`} aria-label={`${name} activity`}>
      <header className="stk-head">
        <span className="stk-provider-logo" title={brand === "unknown" ? "Unknown runtime" : `${brand === "claude" ? "Claude" : brand === "codex" ? "Codex" : "Kilo Code"} runtime`}><ProviderLogo id={brand} /></span>
        <button type="button" className="stk-name" onClick={() => openDrawer(agent.id)}
          title={`${isLead ? "Lead" : `Worker (${agent.role})`} · model ${agent.model ?? "Unknown"} · open details`}>{name}</button>
        {isLead && <span className="stk-lead-tag">lead</span>}
        <span className="stk-rule" aria-hidden="true" />
        <span className="stk-dim stk-meta">
          {fam ? (agent.model?.startsWith("claude-") ? `claude ${fam}` : fam) : "model unknown"}{isLead ? ` · ${workerCount} ${workerCount === 1 ? "subagent" : "subagents"}` : ""}
        </span>
      </header>
      <div className="stk-log" role="log" tabIndex={0} aria-label={`${name} latest events (scroll for more)`}>
        {error && <div className="stk-red">Could not load events: {error}</div>}
        {lines.length === 0 && !error && <div className="stk-dim">No events yet.</div>}
        {lines.map((l) => (
          <div key={l.key} className="stk-line">
            {l.tool ? (
              <>
                <span className={`stk-bullet t-${l.tone}`} aria-hidden="true">{BULLET[l.tone].glyph}</span>
                <span className="stk-sr">{BULLET[l.tone].label}: </span>
                <b>{l.tool}</b><span className="stk-dim">({readableSummary(l.arg ?? "")})</span>
                {l.result && <div className="stk-result"><span className="stk-dim" aria-hidden="true">⎿ </span><span className={`t-${l.result.tone}`}>{readableSummary(l.result.text)}</span></div>}
              </>
            ) : (
              <span className={l.tone === "error" ? "stk-red" : l.tone === "attention" ? "stk-amber" : ""}>
                <span className="stk-clamp" title={l.text}>{l.tone === "attention" && <span aria-hidden="true">◐ </span>}{l.tone === "error" ? "Error: " : ""}{readableSummary(l.text ?? "")}</span>
              </span>
            )}
          </div>
        ))}
      </div>
      <StatusLine agent={agent} tokens={tokens} now={now} isLead={isLead} />
    </section>
  );
}

function agentTokens(a: Agent, usage: UsageRecord[]): number | null {
  // A managed lead's figure is the session total (agentId null); workers and hook agents have their own.
  const own = usage.filter((u) => (a.role === "lead" ? u.agentId === a.id || (u.agentId === null && u.sessionId === a.sessionId) : u.agentId === a.id));
  const vals = own.map((u) => u.totalTokens).filter((n): n is number => n != null);
  return vals.length ? Math.max(...vals) : null;
}

const tildePath = (p: string) => p.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~").replace(/\\/g, "/");

function SessionBlock({ session, lead, workers, now }: { session: Session | undefined; lead: Agent | undefined; workers: Agent[]; now: number }) {
  const { state, billingMode } = useApp();
  const usage = state.usage.filter((u) => u.sessionId === (lead ?? workers[0]).sessionId);
  const totals = sumUsage(usage);
  const leadFam = family(lead?.model ?? null);
  const workerFams = [...new Set(workers.map((w) => family(w.model) ?? "unknown"))].join(", ");
  const nameOf = (w: Agent) => workerTitle(w);
  return (
    <article className="stk-session" aria-label={`Session ${session?.title ?? ""}`}>
      <div className="stk-bar">
        <span>
          {leadFam ?? "unknown"}
          {workers.length > 0 && <> → {workers.length} × {workerFams}</>}
          {" · "}{session ? tildePath(session.cwd) : "unknown folder"}
          {session?.source !== "managed" && <span className="stk-dim"> · {session?.source === "kilo-local" ? "Kilo read-only" : session?.source === "codex-local" ? "Codex · read-only" : "VS Code"}</span>}
        </span>
        <span title={(totals.basis.join("; ") || "No usage reported") + (billingMode === "subscription" ? " — API-equivalent estimate, not a subscription charge" : "")}>
          {totals.cost == null ? <span className="stk-dim">£ unknown</span> : <>{fmtCost(totals.cost)}<span className="stk-dim"> est.</span></>}
        </span>
      </div>
      {lead && <Pane agent={lead} name={leadFam ?? "lead"} isLead workerCount={workers.length} tokens={agentTokens(lead, usage)} now={now} side="full" maxItems={1} />}
      {workers.length > 0 && (
        <div className="stk-workers">
          {workers.map((w, i) => (
            <Pane key={w.id} agent={w} name={nameOf(w)} isLead={false} workerCount={0} tokens={agentTokens(w, usage)}
              now={now} side={i % 2 === 0 ? "left" : "right"} maxItems={2} />
          ))}
        </div>
      )}
    </article>
  );
}

export function LiveActivity({ scope }: { scope: Scope }) {
  useExchangeRate();
  const { state } = useApp();
  const now = useNow(500);
  const agents = stableSort(inScope(state.agents, scope));
  // Only requests that block an agent keep a quiet session on screen; reviews wait on the Overview.
  const pending = new Set(state.interactions.filter((i) => i.kind !== "review" && NEEDS_YOU.includes(i.status)).map((i) => i.sessionId));
  const active = (a: Agent) => a.status === "working" || a.status === "waiting" || a.status === "blocked";
  const shown = (sid: string) => {
    const m = agents.filter((a) => a.sessionId === sid);
    return pending.has(sid) || m.some(active) || m.some((a) => now - a.lastActivityAt < RECENT_MS);
  };
  // Active sessions first, then recently quiet ones; within each group, start order keeps positions stable.
  const all = [...new Set(agents.map((a) => a.sessionId))].filter(shown);
  const isActive = (sid: string) => agents.some((a) => a.sessionId === sid && active(a));
  const sessionIds = [...all.filter(isActive), ...all.filter((sid) => !isActive(sid))];
  return (
    <section aria-label="Live activity" className="stk">
      {sessionIds.length === 0 ? <div className="panel muted">No active or recently ended agents.</div> : sessionIds.map((sid) => {
        const members = agents.filter((a) => a.sessionId === sid);
        return (
          <SessionBlock key={sid} session={sessionOf(state, sid)} lead={members.find((a) => a.role === "lead")}
            workers={members.filter((a) => a.role !== "lead")} now={now} />
        );
      })}
    </section>
  );
}
