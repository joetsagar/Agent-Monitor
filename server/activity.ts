import type { Store } from "./store.ts";
import type { Task } from "../shared/types.ts";
import { redactString } from "./redact.ts";

// Turns observable tool calls into short descriptions. Purely deterministic;
// no model calls.

const one = (s: unknown, n = 140) => {
  const t = redactString(String(s ?? "")).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function describeTool(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case "Bash": case "PowerShell": return `$ ${one(input.command)}`;
    case "Read": return `Read ${one(input.file_path)}`;
    case "Write": return `Write ${one(input.file_path)}`;
    case "Edit": case "MultiEdit": return `Edit ${one(input.file_path)}`;
    case "NotebookEdit": return `Edit notebook ${one(input.notebook_path)}`;
    case "Glob": return `Glob ${one(input.pattern)}`;
    case "Grep": return `Grep ${one(input.pattern)}`;
    case "WebFetch": return `Fetch ${one(input.url)}`;
    case "WebSearch": return `Search "${one(input.query)}"`;
    case "Agent": case "Task": return `Delegate: ${one(input.description ?? input.prompt)}`;
    case "TodoWrite": return "Update plan";
    case "TaskCreate": return `Create task: ${one(input.subject ?? input.description)}`;
    case "TaskUpdate": return `Update task ${one(input.taskId)}${input.status ? " → " + input.status : ""}`;
    case "AskUserQuestion": return "Ask user a question";
    default: return `${name}`;
  }
}

const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmocha\b|\bplaywright\s+test\b|\bnode\s+--test\b/;
export const isTestCommand = (name: string, input: Record<string, unknown> = {}) =>
  (name === "Bash" || name === "PowerShell") && TEST_RE.test(String(input.command ?? ""));

export function changedFile(name: string, input: Record<string, unknown> = {}): string | null {
  if (["Write", "Edit", "MultiEdit"].includes(name) && typeof input.file_path === "string") return input.file_path;
  if (name === "NotebookEdit" && typeof input.notebook_path === "string") return input.notebook_path;
  return null;
}

export function noteChangedFile(store: Store, agentId: string, file: string) {
  const a = store.agents.get(agentId);
  if (!a || a.changedFiles.includes(file)) return;
  store.patchAgent(agentId, { changedFiles: [...a.changedFiles, file].slice(-200) });
}

// TodoWrite replaces the agent's whole list. TaskCreate/TaskUpdate edit one item.
export function applyPlanTool(store: Store, agentId: string, name: string, input: Record<string, unknown>, response: unknown, ts: number) {
  const a = store.agents.get(agentId);
  if (!a) return;
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as { content?: string; status?: string; activeForm?: string }[];
    for (const t of store.tasks.values()) {
      if (t.agentId === agentId && t.source === "TodoWrite" && Number(t.externalId) >= todos.length) {
        store.putTask({ ...t, status: "deleted", updatedAt: ts });
      }
    }
    todos.forEach((t, idx) => {
      store.putTask({
        id: `${agentId}#todo${idx}`, projectId: a.projectId, sessionId: a.sessionId, agentId,
        externalId: String(idx), title: one(t.content, 300), status: normStatus(t.status),
        blockedBy: [], source: "TodoWrite", updatedAt: ts,
      });
    });
    return;
  }
  if (name === "TaskCreate") {
    const r = (response ?? {}) as Record<string, unknown>;
    const taskObj = (r.task ?? r) as Record<string, unknown>;
    const ext = String(taskObj.id ?? taskObj.taskId ?? "");
    if (!ext) return;
    store.putTask({
      id: `${a.sessionId}#task${ext}`, projectId: a.projectId, sessionId: a.sessionId, agentId,
      externalId: ext, title: one(input.subject ?? input.description, 300), status: "pending",
      blockedBy: [], source: "TaskCreate", updatedAt: ts,
    });
    return;
  }
  if (name === "TaskUpdate") {
    const ext = String(input.taskId ?? "");
    const t = store.tasks.get(`${a.sessionId}#task${ext}`);
    if (!t) return;
    const blockedBy = Array.isArray(input.addBlockedBy) ? [...new Set([...t.blockedBy, ...input.addBlockedBy.map(String)])] : t.blockedBy;
    store.putTask({
      ...t, blockedBy,
      title: input.subject ? one(input.subject, 300) : t.title,
      status: input.status ? normStatus(String(input.status)) : t.status,
      agentId: t.agentId, updatedAt: ts,
    });
  }
}

function normStatus(s: unknown): Task["status"] {
  if (s === "completed" || s === "in_progress" || s === "pending" || s === "deleted") return s;
  return "pending";
}

export const shortText = one;
