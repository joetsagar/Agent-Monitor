import { useEffect, useRef, useState } from "react";
import type {
  Interaction, InteractionResponse, PermissionRequestPayload, QuestionRequest, ReviewRequest,
} from "../../../shared/types";
import { ApiError } from "../api";
import { sessionOf, useApp } from "../ctx";
import { folderLink, getDraft, interactionTypeLabel, pretty, setDraft } from "../util";
import { CopyButton, FileRef } from "./common";

interface Draft {
  choices: Record<string, string[]>; // by question text
  other: Record<string, string>;
  text: string; // deny reason / change request
}
const emptyDraft: Draft = { choices: {}, other: {}, text: "" };

function newId(): string {
  try { return crypto.randomUUID(); } catch { return `r-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function useDraft(id: string): [Draft, (d: Draft) => void] {
  const [d, setD] = useState<Draft>(() => ({ ...emptyDraft, ...(getDraft<Draft>(id) ?? {}) }));
  const set = (n: Draft) => { setD(n); setDraft(id, n); };
  return [d, set];
}

function StatusBanner({ i, sending, error }: { i: Interaction; sending: boolean; error: string | null }) {
  let cls = "callout neutral";
  let title = "";
  let body: string | null = i.statusDetail;
  if (sending) { title = "Sending…"; }
  else {
    switch (i.status) {
      case "pending": return error ? <div className="callout failed" role="alert"><strong>Not sent.</strong> {error}</div> : null;
      case "delivering": title = "Delivering to runtime…"; cls = "callout attention"; break;
      case "delivered": title = "Delivered to runtime — waiting for agent"; cls = "callout attention"; break;
      case "resumed": title = "Agent continued"; cls = "callout ok"; break;
      case "failed": title = "Delivery failed"; cls = "callout failed";
        body = (i.statusDetail ?? "No detail given") + " — your draft is kept; you can retry if the request returns to pending."; break;
      case "expired": title = "Expired — can no longer be answered here"; break;
      case "cancelled": title = "Cancelled"; break;
      case "answered_elsewhere": title = "Answered elsewhere (in the original session)"; break;
      case "decided": title = "Decision recorded"; cls = "callout ok"; break;
    }
  }
  return (
    <div className={cls} role="status">
      <strong>{title}</strong>{body && <div className="small">{body}</div>}
      {error && <div className="small">{error}</div>}
    </div>
  );
}

function PermissionDetail({ r }: { r: PermissionRequestPayload }) {
  return (
    <div className="req">
      <dl className="kv">
        <dt>Tool</dt><dd className="mono">{r.displayName && r.displayName !== r.toolName ? `${r.displayName} (${r.toolName})` : r.toolName}</dd>
        {r.title && <><dt>Title</dt><dd>{r.title}</dd></>}
        {r.description && <><dt>Description</dt><dd>{r.description}</dd></>}
        {r.decisionReason && <><dt>Why asked</dt><dd>{r.decisionReason}</dd></>}
        {r.blockedPath && <><dt>Blocked path</dt><dd className="mono">{r.blockedPath}</dd></>}
        {r.filePath && <><dt>File path</dt><dd className="mono">{r.filePath}</dd></>}
        <dt>Working dir</dt><dd className="mono">{r.cwd}</dd>
      </dl>
      {r.command && <><div className="label">Command</div><pre className="scroll cmd">{r.command}</pre></>}
      <div className="label">Input (redacted)</div>
      <pre className="scroll">{pretty(r.input)}</pre>
    </div>
  );
}

function ReviewDetail({ r, cwd }: { r: ReviewRequest; cwd?: string }) {
  return (
    <div className="req">
      <div className="callout attention"><strong>Important:</strong> {r.note}</div>
      <div className="label">Result {r.turnOk ? "(turn ended normally)" : "(turn did not end normally)"}</div>
      <pre className="scroll">{r.resultText}</pre>
      <div className="label">Changed files</div>
      {r.changedFiles.length === 0 ? <div className="muted">None reported</div> : (
        <ul className="plain mono small">
          {r.changedFiles.map((f) => <li key={f}><FileRef path={f} cwd={cwd} /></li>)}
        </ul>
      )}
    </div>
  );
}

function QuestionForm({ i, r, draft, setDraft, disabled, onSubmit }: {
  i: Interaction; r: QuestionRequest; draft: Draft; setDraft: (d: Draft) => void; disabled: boolean;
  onSubmit: (resp: InteractionResponse) => void;
}) {
  const answerFor = (qi: number): string | string[] | null => {
    const q = r.questions[qi];
    const chosen = draft.choices[q.question] ?? [];
    const other = (draft.other[q.question] ?? "").trim();
    if (q.multiSelect) {
      const all = [...chosen, ...(other ? [other] : [])];
      return all.length ? all : null;
    }
    return other || chosen[0] || null;
  };
  const allAnswered = r.questions.every((_, qi) => answerFor(qi) !== null);
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!allAnswered || disabled) return;
      const answers: Record<string, string | string[]> = {};
      r.questions.forEach((q, qi) => { answers[q.question] = answerFor(qi) as string | string[]; });
      onSubmit({ type: "question", answers });
    }}>
      {r.questions.map((q, qi) => {
        const chosen = draft.choices[q.question] ?? [];
        const name = `${i.id}-q${qi}`;
        return (
          <fieldset key={qi} className="qfield" disabled={disabled}>
            <legend><span className="qheader">{q.header}</span></legend>
            <div className="qtext">{q.question}</div>
            {q.options.map((o) => (
              <label key={o.label} className="opt">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"} name={name} checked={chosen.includes(o.label)}
                  onChange={(e) => {
                    const next = q.multiSelect
                      ? (e.target.checked ? [...chosen, o.label] : chosen.filter((x) => x !== o.label))
                      : [o.label];
                    setDraft({
                      ...draft, choices: { ...draft.choices, [q.question]: next },
                      other: q.multiSelect ? draft.other : { ...draft.other, [q.question]: "" },
                    });
                  }}
                />
                <span><strong>{o.label}</strong>{o.description && <span className="muted"> — {o.description}</span>}</span>
              </label>
            ))}
            {r.allowFreeText && (
              <label className="other">
                <span className="small muted">Other{q.multiSelect ? " (added to your selection)" : " (replaces the selection)"}</span>
                <input
                  type="text" value={draft.other[q.question] ?? ""} placeholder="Type your own answer"
                  onChange={(e) => setDraft({
                    ...draft, other: { ...draft.other, [q.question]: e.target.value },
                    choices: q.multiSelect || !e.target.value ? draft.choices : { ...draft.choices, [q.question]: [] },
                  })}
                />
              </label>
            )}
          </fieldset>
        );
      })}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={disabled || !allAnswered}>Send answers</button>
        {!allAnswered && <span className="muted small">Answer every question to send.</span>}
      </div>
    </form>
  );
}

function PermissionForm({ r, draft, setDraft, disabled, onSubmit }: {
  r: PermissionRequestPayload; draft: Draft; setDraft: (d: Draft) => void; disabled: boolean;
  onSubmit: (resp: InteractionResponse) => void;
}) {
  const extra = r.scopeOptions.filter((s) => s.id !== "once");
  return (
    <div>
      <label className="other">
        <span className="small muted">Deny reason (optional, sent to the agent)</span>
        <input type="text" value={draft.text} disabled={disabled} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      </label>
      <div className="actions">
        <button type="button" className="btn primary" disabled={disabled}
          onClick={() => onSubmit({ type: "permission", decision: "approve", scope: "once" })}>Approve once</button>
        <button type="button" className="btn danger" disabled={disabled}
          onClick={() => onSubmit({ type: "permission", decision: "deny", message: draft.text.trim() || undefined })}>Deny</button>
      </div>
      {extra.length > 0 && (
        <div className="scopes">
          <div className="label">Broader approvals (not preselected)</div>
          {extra.map((s) => (
            <div key={s.id} className="scope">
              <button type="button" className="btn" disabled={disabled}
                onClick={() => onSubmit({ type: "permission", decision: "approve", scope: s.id })}>{s.label}</button>
              <div className="small muted">{s.explanation}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewForm({ draft, setDraft, disabled, onSubmit }: {
  draft: Draft; setDraft: (d: Draft) => void; disabled: boolean; onSubmit: (resp: InteractionResponse) => void;
}) {
  const msg = draft.text.trim();
  return (
    <div>
      <label className="other">
        <span className="small muted">Message (required to request changes)</span>
        <textarea rows={3} value={draft.text} disabled={disabled} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      </label>
      <div className="actions">
        <button type="button" className="btn primary" disabled={disabled}
          onClick={() => onSubmit({ type: "review", decision: "accept", message: msg || undefined })}>Accept</button>
        <button type="button" className="btn" disabled={disabled || !msg}
          onClick={() => onSubmit({ type: "review", decision: "request_changes", message: msg })}>Request changes</button>
      </div>
    </div>
  );
}

export function InteractionPanel({ interaction: i, autoFocus }: { interaction: Interaction; autoFocus?: boolean }) {
  const { respond, state } = useApp();
  const session = sessionOf(state, i.sessionId);
  const [draft, setDraftState] = useDraft(i.id);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ridRef = useRef<string | null>(null);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (autoFocus) root.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    // The draft is only discarded once the server says the agent continued or the decision was recorded.
    if (i.status === "resumed" || i.status === "decided") setDraft(i.id, undefined);
  }, [i.status, i.id]);

  const setDraftEdit = (d: Draft) => { ridRef.current = null; setDraftState(d); };

  const submit = async (resp: InteractionResponse) => {
    if (sending) return;
    const rid = (ridRef.current ??= newId());
    setSending(true); setError(null);
    try {
      await respond(i, resp, rid);
      ridRef.current = null;
    } catch (e) {
      if (e instanceof ApiError && e.status > 0) {
        ridRef.current = null;
        setError(e.status === 409 ? `Server: ${e.message} (current status: ${i.status}).` : `Server rejected the response (HTTP ${e.status}): ${e.message}`);
      } else {
        setError("Network error — nothing confirmed. Retrying will reuse the same request id, so it cannot be applied twice.");
      }
    } finally { setSending(false); }
  };

  const r = i.request;
  const interactive = i.interactive;
  const canEdit = interactive && i.status === "pending" && !sending;
  const typeLabel = interactionTypeLabel(i);
  const kindClass = r.type === "review" ? "ix review" : "ix";

  return (
    <section ref={root} tabIndex={-1} className={kindClass} aria-label={`${typeLabel} request`}>
      <h3 className="ix-title">
        {r.type === "review" ? "Review decision" : r.type === "permission" ? "Permission request" : "Question from agent"}
        <span className="badge st-attention">{typeLabel}</span>
      </h3>
      {r.type === "review" && <div className="small muted">This is a review of the agent's result, separate from runtime permission approvals.</div>}
      {!interactive && (
        <div className="callout attention">
          <strong>Answer this in the original Claude Code session in VS Code.</strong>
          <div className="actions">
            {session && <a className="btn small" href={folderLink(session.cwd)}>Open session folder in VS Code</a>}
            {session?.runtimeSessionId && <CopyButton text={`claude --resume ${session.runtimeSessionId}`} label="Copy resume command" />}
          </div>
          {session?.runtimeSessionId && <div className="mono small">claude --resume {session.runtimeSessionId}</div>}
        </div>
      )}
      <StatusBanner i={i} sending={sending} error={error} />
      {r.type === "permission" && <PermissionDetail r={r} />}
      {r.type === "review" && <ReviewDetail r={r} cwd={session?.cwd} />}
      {r.type === "question" && !interactive && (
        <ul className="plain">{r.questions.map((q, n) => <li key={n}><strong>{q.header}:</strong> {q.question}</li>)}</ul>
      )}
      {interactive && i.status === "pending" && (
        <>
          {r.type === "question" && <QuestionForm i={i} r={r} draft={draft} setDraft={setDraftEdit} disabled={!canEdit} onSubmit={submit} />}
          {r.type === "permission" && <PermissionForm r={r} draft={draft} setDraft={setDraftEdit} disabled={!canEdit} onSubmit={submit} />}
          {r.type === "review" && <ReviewForm draft={draft} setDraft={setDraftEdit} disabled={!canEdit} onSubmit={submit} />}
        </>
      )}
      {interactive && i.status !== "pending" && i.response && (
        <details>
          <summary>Response that was submitted</summary>
          <pre className="scroll">{pretty(i.response)}</pre>
        </details>
      )}
    </section>
  );
}
