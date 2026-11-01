import { useEffect, useRef, useState } from "react";
import type { StartSessionRequest } from "../../../shared/types";
import { ApiError, startSession } from "../api";
import { useApp } from "../ctx";

export function NewSessionForm({ onClose }: { onClose: () => void }) {
  const { boot, demo } = useApp();
  const [projectPath, setProjectPath] = useState(boot?.allowedRoots[0] ?? "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(boot?.defaultModel ?? "");
  const [permissionMode, setPermissionMode] = useState<NonNullable<StartSessionRequest["permissionMode"]>>("default");
  const [loadSettings, setLoadSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const req: StartSessionRequest = {
        projectPath: projectPath.trim(), prompt: prompt.trim(), model: model.trim() || undefined, permissionMode, loadSettings,
      };
      const s = await startSession(req);
      setStarted(s.title || s.id);
      setPrompt("");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : "Network error — session may not have started. Check the dashboard before retrying.");
    } finally { setBusy(false); }
  };

  return (
    <form className="panel newsession" onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} aria-label="New session">
      <h2>New managed session</h2>
      <p className="small muted">Starting a session runs Claude Code and uses your Claude usage.</p>
      <label className="field">
        <span>Project path</span>
        <input ref={first} type="text" required value={projectPath} onChange={(e) => setProjectPath(e.target.value)} className="mono" />
        <span className="small muted">Must be inside an allowed root: {boot?.allowedRoots.join(", ") || "none configured"}</span>
      </label>
      <label className="field">
        <span>Prompt</span>
        <textarea required rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Model</span>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} className="mono" />
        </label>
        <label className="field">
          <span>Permission mode</span>
          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as typeof permissionMode)}>
            <option value="default">default</option>
            <option value="plan">plan</option>
            <option value="acceptEdits">acceptEdits</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={loadSettings} onChange={(e) => setLoadSettings(e.target.checked)} />
        <span>Load my Claude settings (CLAUDE.md, hooks, skills)</span>
      </label>
      {demo && <div className="callout attention">Demo mode: this form is NOT simulated and would start a real session. Submit is disabled.</div>}
      {error && <div className="callout failed" role="alert">{error}</div>}
      {started && <div className="callout ok" role="status">Session started: {started}</div>}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={busy || demo || !projectPath.trim() || !prompt.trim()}>{busy ? "Starting…" : "Start session"}</button>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
    </form>
  );
}
