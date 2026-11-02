import { agentOf, inScope, projectName, useApp } from "../ctx";
import type { Scope } from "../ctx";
import { interactionSummary, interactionTypeLabel, NEEDS_YOU, relTime, useNow } from "../util";

export function NeedsYou({ scope }: { scope: Scope }) {
  const { state, openDrawer } = useApp();
  const now = useNow(500);
  const items = inScope(state.interactions, scope)
    .filter((i) => NEEDS_YOU.includes(i.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (items.length === 0) return null;
  return (
    <section className="panel needs" aria-labelledby="needs-h">
      <h2 id="needs-h">Needs you <span className="badge st-attention">{items.length}</span></h2>
      <ul className="plain rows">
        {items.map((i) => {
          const agent = agentOf(state, i.agentId);
          return (
            <li key={i.id}>
              <button type="button" className="row-btn" onClick={() => openDrawer(i.agentId, i.id)}>
                <span className="row-agent">{agent?.name ?? "Unknown agent"}</span>
                <span className="muted small">{projectName(state, i.projectId)}</span>
                <span className={`badge ${i.interactive ? "st-attention" : "st-neutral"}`}>{interactionTypeLabel(i)}</span>
                {i.status !== "pending" && <span className={`badge ${i.status === "failed" ? "st-failed" : "st-neutral"}`}>{i.status === "failed" ? "Delivery failed" : "Delivering"}</span>}
                <span className="muted small">{relTime(i.createdAt, now)}</span>
                <span className="row-summary mono">{interactionSummary(i)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
