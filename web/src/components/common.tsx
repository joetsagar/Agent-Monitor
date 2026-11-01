import { useState } from "react";
import type { Agent, AgentResult, Session, UsageRecord } from "../../../shared/types";
import { copyText, fileLink, fmtCost, fmtNum, minutesSince, STATUS_LABEL, statusClass, sumUsage } from "../util";
import { useApp } from "../ctx";
import type { UsageTotals } from "../util";

export function StatusBadge({ agent, now }: { agent: Agent; now: number }) {
  return (
    <span className="badges">
      <span className={`badge ${statusClass(agent.status)}`}>{STATUS_LABEL[agent.status]}</span>
      {agent.stale && (
        <span className="badge st-attention">Stale — no events for {minutesSince(agent.lastActivityAt, now)}m</span>
      )}
      {agent.errorCount > 0 && (
        <span className="badge st-failed" title="Failed commands stay visible">
          {agent.errorCount} {agent.errorCount === 1 ? "error" : "errors"}
        </span>
      )}
    </span>
  );
}

export function SourceBadge({ session }: { session: Session | undefined }) {
  if (!session) return <span className="badge st-neutral">Unknown source</span>;
  return session.source === "managed"
    ? <span className="badge st-neutral">Managed</span>
    : <span className="badge st-neutral">{session.source === "codex-local" ? "Codex · local logs · read-only" : "VS Code via hooks"}</span>;
}

export function ModelText({ model }: { model: string | null }) {
  return model ? <span className="mono">{model}</span> : <span className="muted">Unknown</span>;
}

const PROVENANCE: Record<AgentResult["provenance"], string> = {
  "agent-reported": "agent-reported",
  runtime: "runtime result",
  "user-checked": "checked by you",
};

export function ResultView({ result, maxHeight }: { result: AgentResult; maxHeight?: number }) {
  const outcome = result.ok === false
    ? <span className="badge st-failed">Failed</span>
    : result.ok === true
      ? <span className="badge st-ok">OK</span>
      : <span className="badge st-neutral">Outcome not determined</span>;
  return (
    <div className="result">
      <div className="result-head">{outcome} <span className="muted small">{PROVENANCE[result.provenance]}</span></div>
      <pre className="scroll" style={maxHeight ? { maxHeight } : undefined}>{result.text}</pre>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button type="button" className="btn small" onClick={async () => {
      const ok = await copyText(text);
      setState(ok ? "ok" : "fail");
      window.setTimeout(() => setState("idle"), 2000);
    }}>
      {state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : label}
    </button>
  );
}

export function CostText({ cost, basis, billingMode, unknownCount = 0 }: {
  cost: number | null; basis?: string | string[] | null; billingMode: "subscription" | "api"; unknownCount?: number;
}) {
  const b = Array.isArray(basis) ? basis.join("; ") : basis;
  if (cost == null) return <span className="muted">Unknown cost</span>;
  return (
    <span title={b ? `Cost basis: ${b}` : "Cost basis not reported"}>
      {fmtCost(cost)} est.
      {unknownCount > 0 && <span className="muted"> (+{unknownCount} record{unknownCount > 1 ? "s" : ""} with unknown cost)</span>}
      {billingMode === "subscription" && <span className="muted small"> — API-equivalent estimate, not a subscription charge</span>}
    </span>
  );
}

export function TokenLine({ t }: { t: UsageTotals }) {
  return (
    <span className="mono small">
      in {fmtNum(t.input)} · out {fmtNum(t.output)} · cache read {fmtNum(t.cacheRead)} · cache write {fmtNum(t.cacheWrite)}
    </span>
  );
}

/** Compact usage for a set of records (e.g. one agent). Included-in-parent records are display-only. */
export function RecordsUsage({ records, billingMode }: { records: UsageRecord[]; billingMode: "subscription" | "api" }) {
  if (records.length === 0) return <span className="muted">Usage: Unknown</span>;
  const t = sumUsage(records);
  const onlyIncluded = t.counted === 0;
  const show: UsageTotals = onlyIncluded ? sumUsage(records.map((r) => ({ ...r, includedInParent: false }))) : t;
  return (
    <span>
      <TokenLine t={show} />
      {onlyIncluded && <span className="muted small"> (included in session total)</span>}
      {" · "}
      <CostText cost={show.cost} basis={show.basis} billingMode={billingMode} unknownCount={show.costUnknownCount} />
    </span>
  );
}

/** Opens in VS Code only when the path is inside the session folder or an allowed root; otherwise plain text. */
export function FileRef({ path, cwd }: { path: string; cwd?: string }) {
  const { boot } = useApp();
  const href = fileLink(path, cwd, boot?.allowedRoots ?? []);
  return href ? <a href={href}>{path}</a> : <span className="mono" title="Outside the authorised project folders; not linked">{path}</span>;
}
