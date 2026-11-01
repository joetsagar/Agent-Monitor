import type { Agent, AgentStatus, UsageRecord } from "../../../shared/types";
import { inScope, useApp } from "../ctx";
import type { Scope } from "../ctx";
import {
  duration, isEnded, NEEDS_YOU, relTime, STATUS_LABEL, stableSort, useNow,
} from "../util";
import { ModelText, RecordsUsage, ResultView, StatusBadge } from "./common";

export const ALL_STATUSES: AgentStatus[] = ["working", "waiting", "blocked", "idle", "failed", "completed", "cancelled"];

export function agentUsage(agent: Agent, usage: UsageRecord[]): UsageRecord[] {
  return usage.filter((u) => u.agentId === agent.id || (agent.role === "lead" && u.agentId === null && u.sessionId === agent.sessionId));
}

function Progress({ agent, now }: { agent: Agent; now: number }) {
  if (agent.subtasks) {
    return (
      <div className="small">
        {agent.subtasks.completed} of {agent.subtasks.total} subtasks complete
        <span className="muted"> (from {agent.subtasks.source})</span>
        {agent.subtasks.inProgress > 0 && <span className="muted">, {agent.subtasks.inProgress} in progress</span>}
      </div>
    );
  }
  return (
    <div className="small muted">
      Stage: {STATUS_LABEL[agent.status]} · last activity {relTime(agent.lastActivityAt, now)}
    </div>
  );
}

export function AgentCard({ agent, now }: { agent: Agent; now: number }) {
  const { state, openDrawer, billingMode } = useApp();
  const pending = state.interactions.filter((i) => i.agentId === agent.id && NEEDS_YOU.includes(i.status));
  const end = agent.endedAt ?? now;
  return (
    <article className={`card ${agent.stale ? "stale" : ""}`} aria-label={`Agent ${agent.name}`}>
      <header className="card-head">
        <button type="button" className="link-btn card-title" onClick={() => openDrawer(agent.id, pending[0]?.id)}>
          {agent.name}
        </button>
        <span className="muted small">{agent.role}</span>
      </header>
      <div className="small">Model: <ModelText model={agent.model} /></div>
      <StatusBadge agent={agent} now={now} />
      {pending.length > 0 && <div><span className="badge st-attention">Needs you: {pending.length} request{pending.length > 1 ? "s" : ""}</span></div>}
      <div className="small"><span className="muted">Task:</span> {agent.assignedTask ?? <span className="muted">None assigned</span>}</div>
      <div className="small"><span className="muted">Now:</span> <span className="mono">{agent.currentAction ?? "—"}</span></div>
      <Progress agent={agent} now={now} />
      {agent.lastResult && <ResultView result={agent.lastResult} maxHeight={90} />}
      <footer className="card-foot small muted">
        <div>Active {relTime(agent.lastActivityAt, now)} · elapsed {duration(end - agent.startedAt)}</div>
        <div><RecordsUsage records={agentUsage(agent, state.usage)} billingMode={billingMode} /></div>
      </footer>
    </article>
  );
}

export function AgentGrid({ scope, filter, onFilter }: { scope: Scope; filter: Set<AgentStatus>; onFilter: (s: Set<AgentStatus>) => void }) {
  const { state, openDrawer } = useApp();
  const now = useNow(1000);
  const all = stableSort(inScope(state.agents, scope));
  const visible = all.filter((a) => filter.size === 0 || filter.has(a.status));
  const active = visible.filter((a) => !isEnded(a));
  const ended = visible.filter(isEnded);
  const toggle = (s: AgentStatus) => {
    const n = new Set(filter);
    if (n.has(s)) n.delete(s); else n.add(s);
    onFilter(n);
  };
  return (
    <section className="panel" aria-labelledby="agents-h">
      <div className="panel-head">
        <h2 id="agents-h">Agents <span className="muted small">({active.length} active)</span></h2>
        <div className="filters" role="group" aria-label="Filter by status">
          {ALL_STATUSES.map((s) => (
            <button key={s} type="button" className={`toggle ${filter.has(s) ? "on" : ""}`} aria-pressed={filter.has(s)} onClick={() => toggle(s)}>
              {STATUS_LABEL[s]} ({all.filter((a) => a.status === s).length})
            </button>
          ))}
          {filter.size > 0 && <button type="button" className="toggle" onClick={() => onFilter(new Set())}>Clear filter</button>}
        </div>
      </div>
      {all.length === 0 ? <div className="muted">No agents yet. Start a Claude session or work in Codex inside an allowed project folder.</div> : (
        <div className="grid">
          {active.map((a) => <AgentCard key={a.id} agent={a} now={now} />)}
          {active.length === 0 && <div className="muted">No active agents match this filter.</div>}
        </div>
      )}
      {ended.length > 0 && (
        <details className="results" open>
          <summary><h3 className="inline">Results ({ended.length})</h3></summary>
          <ul className="plain">
            {ended.map((a) => (
              <li key={a.id}>
                <details>
                  <summary>
                    <span className="row-agent">{a.name}</span>
                    <span className={`badge ${a.status === "completed" ? "st-ok" : "st-neutral"}`}>{STATUS_LABEL[a.status]}</span>
                    {a.errorCount > 0 && <span className="badge st-failed">{a.errorCount} errors</span>}
                    <span className="muted small">{relTime(a.endedAt ?? a.lastActivityAt, now)}</span>
                  </summary>
                  <div className="result-body">
                    <div className="small"><span className="muted">Task:</span> {a.assignedTask ?? "None assigned"}</div>
                    {a.lastResult ? <ResultView result={a.lastResult} maxHeight={200} /> : <div className="muted small">No result recorded.</div>}
                    <button type="button" className="btn small" onClick={() => openDrawer(a.id)}>Open details</button>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
