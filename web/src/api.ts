import { useEffect, useReducer, useRef, useState } from "react";
import type {
  Agent, EventRow, Interaction, InteractionResponse, Project, ServerInfo, Session, Snapshot,
  StartSessionRequest, StreamMessage, Task, UsageRecord,
  WidgetUsageSnapshot,
  ArchiveResult,
} from "../../shared/types";

export interface Bootstrap {
  token: string;
  port: number;
  allowedRoots: string[];
  defaultModel: string;
  billingMode: "subscription" | "api";
}

let token = "";
export function setToken(t: string): void { token = t; }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const r = await fetch("/api/bootstrap");
  if (!r.ok) throw new ApiError(r.status, `bootstrap failed (${r.status})`);
  const b = (await r.json()) as Bootstrap;
  setToken(b.token);
  return b;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-agent-monitor-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
    throw new ApiError(r.status, msg);
  }
  return data as T;
}

export const fetchAgentEvents = (agentId: string, limit = 300) =>
  call<EventRow[]>("GET", `/api/agents/${encodeURIComponent(agentId)}/events?limit=${limit}`);
export const fetchWidgetUsage = () => call<WidgetUsageSnapshot>("GET", "/api/widget-usage");
export const refreshWidgetUsage = () => call<WidgetUsageSnapshot>("POST", "/api/widget-usage/refresh", {});
export const respondToInteraction = (id: string, response: InteractionResponse, clientRequestId: string) =>
  call<Interaction>("POST", `/api/interactions/${encodeURIComponent(id)}/respond`, { response, clientRequestId });
export const startSession = (req: StartSessionRequest) => call<Session>("POST", "/api/sessions", req);
export const sendSessionMessage = (id: string, text: string) =>
  call<unknown>("POST", `/api/sessions/${encodeURIComponent(id)}/message`, { text });
export const cancelSession = (id: string) => call<unknown>("POST", `/api/sessions/${encodeURIComponent(id)}/cancel`, {});
export const endSession = (id: string) => call<unknown>("POST", `/api/sessions/${encodeURIComponent(id)}/end`, {});
export const archiveSession = (id: string, lastEventAt: number) => call<ArchiveResult>("POST", `/api/sessions/${encodeURIComponent(id)}/archive`, { lastEventAt });
export const archiveJob = (id: string) => call<ArchiveResult>("GET", `/api/vscode/jobs/${encodeURIComponent(id)}`);
export const patchProject = (id: string, patch: { name?: string; objective?: string | null }) =>
  call<Project>("PATCH", `/api/projects/${encodeURIComponent(id)}`, patch);

// ---------- store ----------

export interface MonitorState {
  loaded: boolean;
  server: ServerInfo | null;
  projects: Project[];
  sessions: Session[];
  agents: Agent[];
  tasks: Task[];
  interactions: Interaction[];
  milestones: EventRow[];
  usage: UsageRecord[];
  liveEvents: Record<string, EventRow[]>; // by agent id, oldest first
  epoch: number; // increments on every snapshot (connect/reconnect) so event lists re-seed
}

export const emptyState: MonitorState = {
  loaded: false, server: null, projects: [], sessions: [], agents: [], tasks: [], interactions: [],
  milestones: [], usage: [], liveEvents: {}, epoch: 0,
};

const MAX_MILESTONES = 100;
const MAX_LIVE = 300;

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function reduce(s: MonitorState, m: StreamMessage): MonitorState {
  switch (m.type) {
    case "snapshot": {
      const d: Snapshot = m.data;
      return {
        loaded: true, server: d.server, projects: d.projects, sessions: d.sessions, agents: d.agents,
        tasks: d.tasks, interactions: d.interactions,
        milestones: [...d.milestones].sort((a, b) => b.ts - a.ts).slice(0, MAX_MILESTONES),
        usage: d.usage, liveEvents: {}, epoch: s.epoch + 1, // event lists re-seed from the events endpoint
      };
    }
    case "project": return { ...s, projects: upsert(s.projects, m.data) };
    case "session": return { ...s, sessions: upsert(s.sessions, m.data) };
    case "agent": return { ...s, agents: upsert(s.agents, m.data) };
    case "task": return { ...s, tasks: upsert(s.tasks, m.data) };
    case "interaction": {
      const cur = s.interactions.find((x) => x.id === m.data.id);
      if (cur && cur.updatedAt > m.data.updatedAt) return s; // never regress to an older copy
      return { ...s, interactions: upsert(s.interactions, m.data) };
    }
    case "usage": return { ...s, usage: upsert(s.usage, m.data) };
    case "server": return { ...s, server: m.data };
    case "event": {
      const e = m.data;
      if (e.kind === "marker") return s;
      const prev = s.liveEvents[e.agentId] ?? [];
      let live = s.liveEvents;
      if (!prev.some((x) => x.id === e.id)) {
        live = { ...s.liveEvents, [e.agentId]: [...prev, e].slice(-MAX_LIVE) };
      }
      let milestones = s.milestones;
      if (e.milestone && !milestones.some((x) => x.id === e.id)) {
        milestones = [e, ...milestones].sort((a, b) => b.ts - a.ts).slice(0, MAX_MILESTONES);
      }
      return { ...s, liveEvents: live, milestones };
    }
  }
}

export type ConnState = "connecting" | "live" | "reconnecting";

export function useMonitor() {
  const [state, dispatch] = useReducer(reduce, emptyState);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const snapshotSeen = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retry: number | undefined;
    // eslint-disable-next-line prefer-const
    let start: () => void = () => {};
    const open = (b: Bootstrap) => {
      es = new EventSource(`/api/stream?token=${encodeURIComponent(b.token)}`);
      es.onopen = () => setConn("live");
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as StreamMessage;
          if (msg.type === "snapshot") snapshotSeen.current++;
          dispatch(msg);
          setLastMessageAt(Date.now());
          setConn("live");
        } catch { /* ignore malformed frame */ }
      };
      es.onerror = () => {
        setConn("reconnecting");
        // CLOSED = the browser gave up (e.g. token changed after a backend restart): re-bootstrap.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          retry = window.setTimeout(start, 3000);
        }
      };
    };
    start = () => {
      fetchBootstrap().then((b) => { if (!cancelled) { setBoot(b); setBootError(null); open(b); } })
        .catch((e) => {
          if (cancelled) return;
          setBootError(e instanceof Error ? e.message : String(e));
          setConn("reconnecting");
          retry = window.setTimeout(start, 3000);
        });
    };
    start();
    return () => { cancelled = true; es?.close(); window.clearTimeout(retry); };
  }, []);

  return { state, dispatch, boot, bootError, conn, lastMessageAt };
}
