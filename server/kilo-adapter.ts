import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { sanitize } from "./redact.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { RuntimeState, AgentStatus } from "../shared/types.ts";

// Read-only CLI database observer. Select metadata only: prompts, reasoning,
// credentials, tool arguments and outputs never leave the source database.
const CAPS = { answerQuestions: false, approvePermissions: false, sendMessages: false, cancel: false, resume: false };
const within = (path: string, root: string) => { const r = relative(resolve(root), resolve(path)); return !r || (!r.startsWith("..") && !isAbsolute(r)); };
interface LocalSession { id: string; parent_id: string | null; directory: string; time_created: number; time_updated: number; time_archived: number | null }
export class KiloAdapter {
  readonly databasePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private store: Store;
  private cfg: Config;
  constructor(store: Store, cfg: Config) {
    this.store = store; this.cfg = cfg;
    this.databasePath = resolve(cfg.kilo?.databasePath ?? join(homedir(), ".local", "share", "kilo", "kilo.db"));
  }
  start() {
    if (this.cfg.kilo?.enabled === false) { this.report("disabled", 0); return; }
    this.poll();
    this.timer = setInterval(() => this.poll(), Math.max(1000, this.cfg.kilo?.pollIntervalMs ?? 2000));
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private report(status: "watching" | "unavailable" | "disabled", count: number, error: string | null = null) {
    this.store.setServer({ kilo: { enabled: status !== "disabled", status, sessionsTracked: count, lastScanAt: status === "watching" ? Date.now() : null, error } });
  }
  poll() {
    if (this.cfg.kilo?.enabled === false) return;
    let db: DatabaseSync | undefined;
    try {
      if (!existsSync(this.databasePath)) throw new Error("missing");
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100");
      db.exec("BEGIN");
      const rows = db.prepare("SELECT id,parent_id,directory,time_created,time_updated,time_archived FROM session WHERE time_updated >= ? ORDER BY time_updated DESC LIMIT ?")
        .all(Date.now() - Math.max(1, this.cfg.kilo?.lookbackDays ?? 7) * 86400000, Math.min(500, Math.max(1, this.cfg.kilo?.maxSessions ?? 100))) as unknown as LocalSession[];
      const allowed = rows.filter(r => typeof r.directory === "string" && this.cfg.allowedRoots.some(root => within(r.directory, root)));
      const byId = new Map(allowed.map(r => [r.id, r]));
      for (const r of allowed) {
        let root = r; const seen = new Set([r.id]);
        while (root.parent_id && byId.has(root.parent_id) && !seen.has(root.parent_id)) { root = byId.get(root.parent_id)!; seen.add(root.id); }
        // Never attach an unverified or out-of-scope parent.
        if (root.parent_id) continue;
        const sid = `kl_${root.id}`;
        if (!this.store.sessions.has(sid)) this.store.putSession({ id: sid, projectId: this.store.projectFor(root.directory).id, source: "kilo-local", runtimeSessionId: root.id,
          title: "Kilo session", cwd: root.directory, model: null, authSource: null, billingMode: null, runtimeState: "idle", runtimeStateDetail: "Observed from local Kilo CLI database; interact in Kilo", permissionMode: null,
          startedAt: root.time_created, lastEventAt: root.time_updated, endedAt: null, capabilities: CAPS, claudeCodeVersion: null });
        const m = db.prepare(`SELECT id,time_updated,json_extract(data,'$.role') role,json_extract(data,'$.modelID') model,
          json_extract(data,'$.time.completed') completed,json_extract(data,'$.finish') finish,json_type(data,'$.error') error
          FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 1`).get(r.id) as Record<string, any> | undefined;
        const tool = m && db.prepare(`SELECT id,time_updated,json_extract(data,'$.tool') tool,json_extract(data,'$.state.status') status FROM part
          WHERE message_id=? AND json_extract(data,'$.type')='tool' ORDER BY time_created DESC,id DESC LIMIT 1`).get(m.id) as Record<string, any> | undefined;
        const ts = Math.max(r.time_updated, m?.time_updated ?? 0, tool?.time_updated ?? 0);
        if (!Number.isFinite(ts)) continue;
        const active = !!m && (m.role === "user" || !m.completed || m.finish === "tool-calls");
        const state: RuntimeState = r.time_archived ? "ended" : m?.error && m.error !== "null" ? "failed" : active ? Date.now() - ts > this.cfg.staleAfterMs ? "interrupted" : "running" : "idle";
        const status: AgentStatus = state === "ended" ? "completed" : state === "failed" ? "failed" : state === "running" ? "working" : "idle";
        const agent = this.store.ensureAgent(sid, r.id === root.id ? null : r.id, { ts: r.time_created, name: r.id === root.id ? "lead" : "Kilo worker", role: r.id === root.id ? "lead" : "subagent" });
        if (ts < agent.lastActivityAt) continue;
        const model = typeof m?.model === "string" ? sanitize(m.model.slice(0, 200)) : agent.model;
        const action = state === "interrupted" ? "Activity stopped; current Kilo state unknown" : state === "running" ? "Kilo turn in progress" : state === "idle" ? "Kilo turn finished" : `Kilo session ${state}`;
        const key = "kilo:" + createHash("sha256").update(JSON.stringify([r.id, ts, m?.id, tool?.id, tool?.status, state, model])).digest("hex");
        if (this.store.hasEvent(key)) continue;
        this.store.patchAgent(agent.id, { status, model, modelSource: model ? "local Kilo CLI database" : null, currentAction: action, currentActionAt: ts, endedAt: r.time_archived ?? null }, ts);
        if (r.id === root.id) this.store.patchSession(sid, { model, runtimeState: state, endedAt: r.time_archived ?? null });
        this.store.addEvent({ dedupeKey: key, sessionId: sid, agentId: agent.id, ts, kind: "marker", summary: action, status: state === "failed" ? "error" : "info" });
      }
      db.exec("COMMIT");
      this.report("watching", allowed.length);
    } catch { this.report("unavailable", 0, "Could not read local Kilo CLI sessions (missing, busy or unsupported database)"); }
    finally { db?.close(); }
  }
}
