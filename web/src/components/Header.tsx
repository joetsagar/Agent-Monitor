import type { AgentStatus } from "../../../shared/types";
import type { ConnState } from "../api";
import { inScope, useApp } from "../ctx";
import type { Scope } from "../ctx";
import { NEEDS_YOU, relTime, STATUS_LABEL, useNow } from "../util";

function ConnBadge({ conn, last }: { conn: ConnState; last: number | null }) {
  const now = useNow(1000);
  const label = conn === "live" ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting";
  const cls = conn === "live" ? "st-ok" : conn === "connecting" ? "st-neutral" : "st-attention";
  return <span className={`badge ${cls}`} role="status" title={`Live activity connection${last != null ? ` · last message ${relTime(last, now)}` : ""}`}>{label}</span>;
}

export function Header(props: {
  scope: Scope; setScope: (s: Scope) => void;
  clearableCount: number; clearedCount: number; onClearFinished: () => void; onShowCleared: () => void;
  archiving: boolean;
  conn: ConnState; lastMessageAt: number | null; bootError: string | null;
  requestsOpen: boolean; onToggleRequests: () => void;
}) {
  const { scope, setScope, conn, lastMessageAt, bootError } = props;
  const { state } = useApp();
  const agents = inScope(state.agents, scope);
  const count = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
  const stale = agents.filter((a) => a.stale).length;
  const needsYou = inScope(state.interactions, scope).filter((i) => NEEDS_YOU.includes(i.status)).length;

  return (
    <header className="top live-toolbar">
      <div className="top-row">
        <div className="monitor-brand"><h1>Agent Monitor</h1><span className="small muted">Live activity</span></div>
        <label className="inline-field project-select">
          <span className="stk-sr">Project</span>
          <select aria-label="Project" value={scope.projectId} onChange={(e) => setScope({ projectId: e.target.value })}>
            <option value="all">All projects</option>
            {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="toolbar-actions">
          <button type="button" className="btn small" disabled={props.archiving || props.clearableCount === 0} onClick={props.onClearFinished}
            title="Save full conversation text to Obsidian, then close the associated VS Code tab while keeping history. Only successful sessions are cleared.">{props.archiving ? "Saving and closing..." : `Clear finished (${props.clearableCount})`}</button>
          {props.clearedCount > 0 && <button type="button" className="btn small" onClick={props.onShowCleared}>Show cleared ({props.clearedCount})</button>}
        </div>
      </div>
      {bootError && <div className="callout failed small" role="alert">Cannot reach the backend: {bootError}. Retrying…</div>}
      <div className="top-compact small">
        <ConnBadge conn={conn} last={lastMessageAt} />
        {state.server?.kilo && <span className={`badge ${state.server.kilo.status === "watching" ? "st-ok" : "st-neutral"}`}
          title={state.server.kilo.error ?? `Read-only Kilo CLI observer; ${state.server.kilo.sessionsTracked} sessions tracked. Questions and approvals stay in Kilo.`}>
          Kilo: {state.server.kilo.status}
        </span>}
        {state.server?.codex && <span className={`badge ${state.server.codex.status === "watching" ? "st-ok" : "st-neutral"}`}
          title={state.server.codex.error ?? `Read-only Codex observer; ${state.server.codex.filesTracked} log files tracked. Questions and approvals stay in Codex.`}>
          Codex: {state.server.codex.status}
        </span>}
        {(["working", "waiting", "failed"] as AgentStatus[]).map((s) => <span key={s} className="stat">{count(s)} {STATUS_LABEL[s].toLowerCase()}</span>)}
        {stale > 0 && <span className="stat st-attention-text">{stale} stale</span>}
        {needsYou > 0 && <button type="button" className="btn small needs-btn" aria-expanded={props.requestsOpen} aria-controls="pending-requests" onClick={props.onToggleRequests}>
          Needs you ({needsYou}){props.requestsOpen ? " · hide" : ""}
        </button>}
      </div>
    </header>
  );
}
