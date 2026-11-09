import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type {
  Agent, EventRow, EventStatus, Interaction, InteractionStatus, Project, ServerInfo,
  Session, Snapshot, StreamMessage, Task, UsageRecord,
} from "../shared/types.ts";
import { sanitize } from "./redact.ts";

export interface NormEvent {
  dedupeKey: string;
  sessionId: string;
  agentId: string;
  ts: number;
  kind: string;
  toolName?: string | null;
  toolUseId?: string | null;
  summary: string;
  status: EventStatus;
  milestone?: boolean;
  detail?: unknown;
}

type Kind = "project" | "session" | "agent" | "task" | "interaction" | "usage";
type Listener = (m: StreamMessage) => void;

const ACTIVE: Agent["status"][] = ["working", "waiting"];
const CODEX_ABANDON_MS = 6 * 3600_000;

export class Store {
  private db: DatabaseSync;
  private listeners = new Set<Listener>();
  projects = new Map<string, Project>();
  sessions = new Map<string, Session>();
  agents = new Map<string, Agent>();
  tasks = new Map<string, Task>();
  interactions = new Map<string, Interaction>();
  usage = new Map<string, UsageRecord>();
  server: ServerInfo;
  // Clear watermark (epoch ms): observers and hooks ignore anything older, so
  // history cannot come back after a /clear (restart, Codex/Kilo rescans, late hooks).
  clearedAt = 0;

  constructor(db: DatabaseSync, server: ServerInfo) {
    this.db = db;
    this.server = server;
    const mark = db.prepare("SELECT value FROM meta WHERE key='clearedAt'").get() as { value: string } | undefined;
    this.clearedAt = mark ? Number(mark.value) || 0 : 0;
    const rows = db.prepare("SELECT kind, data FROM entities").all() as { kind: Kind; data: string }[];
    for (const r of rows) {
      const v = JSON.parse(r.data);
      ({ project: this.projects, session: this.sessions, agent: this.agents, task: this.tasks,
        interaction: this.interactions, usage: this.usage } as Record<Kind, Map<string, unknown>>)[r.kind].set(v.id, v);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(m: StreamMessage) {
    for (const fn of this.listeners) {
      try { fn(m); } catch { /* a broken client must not affect others */ }
    }
  }

  private persist(kind: Kind, v: { id: string; sessionId?: string }) {
    this.db.prepare(
      "INSERT INTO entities(kind,id,session_id,updated_at,data) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(kind,id) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at, data=excluded.data",
    ).run(kind, v.id, v.sessionId ?? null, Date.now(), JSON.stringify(v));
    this.emit({ type: kind, data: v } as StreamMessage);
  }

  // ---- projects ----
  projectFor(rootPath: string): Project {
    const norm = resolve(rootPath);
    const id = "p_" + createHash("sha1").update(norm.toLowerCase()).digest("hex").slice(0, 12);
    let p = this.projects.get(id);
    if (!p) {
      p = { id, name: basename(norm) || norm, rootPath: norm, objective: null, createdAt: Date.now() };
      this.projects.set(id, p);
      this.persist("project", p);
    }
    return p;
  }

  updateProject(id: string, patch: Partial<Pick<Project, "name" | "objective">>): Project | null {
    const p = this.projects.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    this.persist("project", p);
    return p;
  }

  // ---- sessions ----
  putSession(s: Session) {
    this.sessions.set(s.id, s);
    this.persist("session", s);
  }

  patchSession(id: string, patch: Partial<Session>): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    Object.assign(s, patch);
    this.persist("session", s);
    return s;
  }

  // ---- agents ----
  agentId(sessionId: string, runtimeAgentId: string | null) {
    return `${sessionId}/${runtimeAgentId ?? "lead"}`;
  }

  ensureAgent(sessionId: string, runtimeAgentId: string | null, init: Partial<Agent> & { ts: number }): Agent {
    const id = this.agentId(sessionId, runtimeAgentId);
    let a = this.agents.get(id);
    if (!a) {
      const s = this.sessions.get(sessionId)!;
      a = {
        id, sessionId, projectId: s.projectId,
        parentAgentId: runtimeAgentId ? this.agentId(sessionId, null) : null,
        runtimeAgentId,
        name: runtimeAgentId ? "worker" : "lead",
        role: runtimeAgentId ? "subagent" : "lead",
        model: null, modelSource: null, status: "working",
        assignedTask: null, currentAction: null, currentActionAt: null, lastResult: null,
        lastActivityAt: init.ts, startedAt: init.ts, endedAt: null, stale: false, subtasks: null,
        changedFiles: [], errorCount: 0,
        ...init,
      } as Agent;
      delete (a as Partial<Agent> & { ts?: number }).ts;
      this.agents.set(id, a);
      this.persist("agent", a);
    }
    return a;
  }

  // Out-of-order safe: the current action only moves forward in time.
  patchAgent(id: string, patch: Partial<Agent>, ts?: number): Agent | null {
    const a = this.agents.get(id);
    if (!a) return null;
    if (ts !== undefined) {
      if ("currentAction" in patch && a.currentActionAt !== null && ts < a.currentActionAt) {
        delete patch.currentAction;
        delete patch.currentActionAt;
      }
      if (ts > a.lastActivityAt) a.lastActivityAt = ts;
    }
    Object.assign(a, patch);
    if (ACTIVE.includes(a.status) && a.stale && ts !== undefined) a.stale = false;
    this.persist("agent", a);
    return a;
  }

  // ---- events ----
  addEvent(e: NormEvent): EventRow | null {
    const detail = e.detail === undefined ? null : JSON.stringify(sanitize(e.detail));
    const summary = sanitize(e.summary, 500);
    const res = this.db.prepare(
      "INSERT OR IGNORE INTO events(dedupe_key,session_id,agent_id,ts,received_at,kind,tool_name,tool_use_id,summary,status,milestone,detail) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(e.dedupeKey, e.sessionId, e.agentId, e.ts, Date.now(), e.kind, e.toolName ?? null, e.toolUseId ?? null,
      summary, e.status, e.milestone ? 1 : 0, detail);
    if (res.changes === 0) return null; // duplicate delivery
    const row: EventRow = {
      id: Number(res.lastInsertRowid), sessionId: e.sessionId, agentId: e.agentId, ts: e.ts, kind: e.kind,
      toolName: e.toolName ?? null, toolUseId: e.toolUseId ?? null, summary, status: e.status, milestone: !!e.milestone,
    };
    const s = this.sessions.get(e.sessionId);
    if (s && e.ts > s.lastEventAt) { s.lastEventAt = e.ts; this.persist("session", s); }
    if (e.kind !== "marker") this.emit({ type: "event", data: row });
    return row;
  }

  hasEvent(dedupeKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE dedupe_key=?").get(dedupeKey);
  }

  eventsForAgent(agentId: string, limit = 300, includeChildren = false): EventRow[] {
    const sql = includeChildren
      ? "SELECT * FROM events WHERE (agent_id=? OR agent_id LIKE ?) AND kind != 'marker' ORDER BY ts DESC, id DESC LIMIT ?"
      : "SELECT * FROM events WHERE agent_id=? AND kind != 'marker' ORDER BY ts DESC, id DESC LIMIT ?";
    const sessionPrefix = agentId.replace(/\/lead$/, "/") + "%";
    const rows = (includeChildren
      ? this.db.prepare(sql).all(agentId, sessionPrefix, limit)
      : this.db.prepare(sql).all(agentId, limit)) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  milestones(limit = 100): EventRow[] {
    return (this.db.prepare("SELECT * FROM events WHERE milestone=1 ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map((r) => ({ ...rowToEvent(r), detail: undefined }));
  }

  // ---- tasks ----
  putTask(t: Task) {
    this.tasks.set(t.id, t);
    this.persist("task", t);
    this.recomputeSubtasks(t.agentId);
  }

  recomputeSubtasks(agentId: string) {
    const list = [...this.tasks.values()].filter((t) => t.agentId === agentId && t.status !== "deleted");
    const a = this.agents.get(agentId);
    if (!a) return;
    a.subtasks = list.length === 0 ? null : {
      total: list.length,
      completed: list.filter((t) => t.status === "completed").length,
      inProgress: list.filter((t) => t.status === "in_progress").length,
      source: list[0].source,
    };
    this.persist("agent", a);
  }

  // ---- interactions ----
  putInteraction(i: Interaction) {
    this.interactions.set(i.id, i);
    this.persist("interaction", i);
  }

  // Atomic state transition: succeeds only from one of the expected states,
  // which is what prevents duplicate submissions from both reaching the runtime.
  transition(id: string, from: InteractionStatus[], to: InteractionStatus, patch: Partial<Interaction> = {}): Interaction | null {
    const i = this.interactions.get(id);
    if (!i || !from.includes(i.status)) return null;
    Object.assign(i, patch, { status: to, updatedAt: Date.now() });
    this.persist("interaction", i);
    return i;
  }

  interactionByToolUse(sessionId: string, toolUseId: string): Interaction | undefined {
    for (const i of this.interactions.values()) if (i.sessionId === sessionId && i.toolUseId === toolUseId) return i;
    return undefined;
  }

  // ---- usage ----
  putUsage(u: UsageRecord) {
    this.usage.set(u.id, u);
    this.persist("usage", u);
  }

  // ---- attempts ----
  startAttempt(sessionId: string, kind: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO attempts(id,session_id,kind,started_at) VALUES(?,?,?,?)").run(id, sessionId, kind, Date.now());
    return id;
  }

  endAttempt(id: string, outcome: string) {
    this.db.prepare("UPDATE attempts SET ended_at=?, outcome=? WHERE id=?").run(Date.now(), outcome, id);
  }

  // ---- derived presentation helpers ----
  refreshStale(now = Date.now()) {
    for (const a of this.agents.values()) {
      const s = this.sessions.get(a.sessionId);
      // A waiting agent is legitimately quiet; staleness is about unexplained silence.
      const stale = a.status === "working" && now - a.lastActivityAt > this.server.staleAfterMs &&
        !(s?.source === "managed" && s.runtimeState === "running");
      if (stale !== a.stale) { a.stale = stale; this.persist("agent", a); }
      // Codex logs never record a crashed client. After long silence treat the
      // turn as interrupted (like Kilo) so Clear finished can archive it.
      if (s?.source === "codex-local" && a.status === "working" && now - a.lastActivityAt > CODEX_ABANDON_MS) {
        a.status = "cancelled"; a.stale = false; a.currentAction = "No Codex activity for 6h; treated as interrupted"; this.persist("agent", a);
        if (s.runtimeState === "running") this.patchSession(s.id, { runtimeState: "interrupted" });
      }
    }
  }

  // Wipes all agent information (sessions, agents, tasks, requests, usage, events)
  // and raises the watermark to `at`. Kept: sessions for which `keep` is true and
  // sessions with activity at or after `at` (genuinely live), plus user-set project objectives.
  clearAll(at: number, keep: (s: Session) => boolean = () => false): { removed: number; kept: number } {
    const survivors = new Set<string>();
    for (const s of this.sessions.values()) if (s.lastEventAt >= at || keep(s)) survivors.add(s.id);
    const drop = [...this.sessions.keys()].filter((id) => !survivors.has(id));
    const dropSet = new Set(drop);
    const del = (kind: Kind, map: Map<string, { sessionId?: string; id: string }>, owned: (v: { sessionId?: string; id: string }) => boolean) => {
      for (const [id, v] of [...map]) if (owned(v)) { map.delete(id); this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id); }
    };
    this.db.exec("BEGIN");
    try {
      del("session", this.sessions as Map<string, any>, (v) => dropSet.has(v.id));
      for (const [kind, map] of [["agent", this.agents], ["task", this.tasks], ["interaction", this.interactions], ["usage", this.usage]] as const) {
        // Records with no session (e.g. account-level usage) are also agent information.
        del(kind, map as Map<string, any>, (v) => !v.sessionId || dropSet.has(v.sessionId) || !this.sessions.has(v.sessionId));
      }
      const keepProjects = new Set([...this.sessions.values()].map((s) => s.projectId));
      for (const [id, p] of [...this.projects]) {
        if (keepProjects.has(id) || p.objective) continue;
        this.projects.delete(id); this.db.prepare("DELETE FROM entities WHERE kind='project' AND id=?").run(id);
      }
      const delEv = this.db.prepare("DELETE FROM events WHERE session_id=?"), delAt = this.db.prepare("DELETE FROM attempts WHERE session_id=?");
      for (const id of drop) { delEv.run(id); delAt.run(id); }
      // Orphans from sessions already gone.
      this.db.exec("DELETE FROM events WHERE ts < " + Math.floor(at) + " AND session_id NOT IN (SELECT id FROM entities WHERE kind='session')");
      this.clearedAt = at;
      this.db.prepare("INSERT INTO meta(key,value) VALUES('clearedAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(at));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.emit({ type: "snapshot", data: this.snapshot() });
    return { removed: drop.length, kept: survivors.size };
  }

  setServer(patch: Partial<ServerInfo>) {
    Object.assign(this.server, patch);
    this.emit({ type: "server", data: this.server });
  }

  snapshot(): Snapshot {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const interactions = [...this.interactions.values()]
      .filter((i) => i.status === "pending" || i.status === "delivering" || i.updatedAt > cutoff)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    return {
      server: this.server,
      projects: [...this.projects.values()],
      sessions: [...this.sessions.values()],
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      interactions,
      milestones: this.milestones(),
      usage: [...this.usage.values()],
    };
  }
}

function rowToEvent(r: Record<string, unknown>): EventRow {
  return {
    id: Number(r.id), sessionId: String(r.session_id), agentId: String(r.agent_id), ts: Number(r.ts),
    kind: String(r.kind), toolName: (r.tool_name as string) ?? null, toolUseId: (r.tool_use_id as string) ?? null,
    summary: String(r.summary), status: r.status as EventStatus, milestone: r.milestone === 1,
    detail: r.detail ? JSON.parse(String(r.detail)) : undefined,
  };
}
