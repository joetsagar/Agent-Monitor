import { agentOf, useApp } from "../ctx";
import type { Scope } from "../ctx";
import { clock } from "../util";

export function MilestoneFeed({ scope }: { scope: Scope }) {
  const { state } = useApp();
  const items = state.milestones
    .filter((e) => scope.projectId === "all" || state.sessions.find((s) => s.id === e.sessionId)?.projectId === scope.projectId)
    .slice(0, 100);
  return (
    <section className="panel" aria-labelledby="ms-h">
      <h2 id="ms-h">Milestones</h2>
      {items.length === 0 ? <div className="muted">No milestones yet.</div> : (
        <ul className="plain feed">
          {items.map((e) => {
            const a = agentOf(state, e.agentId);
            const label = e.status === "error" ? "Failed" : e.status === "ok" ? "OK" : e.status === "pending" ? "Pending" : "Info";
            const cls = e.status === "error" ? "st-failed" : e.status === "ok" ? "st-ok" : "st-neutral";
            return (
              <li key={e.id}>
                <span className="mono muted">{clock(e.ts)}</span>
                <span className="feed-agent">{a?.name ?? e.agentId}</span>
                <span className={`badge ${cls}`}>{label}</span>
                <span>{e.summary}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
