// Client-only SIMULATED data for ?demo=1. Nothing here is ever sent to the server.
import type { Agent, EventRow, Interaction, InteractionResponse, Project, Session, Task, UsageRecord } from "../../shared/types";

export const DEMO = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "1";
export const isDemoId = (id: string) => id.startsWith("demo:");

export interface DemoData {
  projects: Project[]; sessions: Session[]; agents: Agent[]; tasks: Task[];
  interactions: Interaction[]; usage: UsageRecord[]; milestones: EventRow[];
}

export function makeDemo(now: number): DemoData {
  const min = 60_000;
  const caps = { answerQuestions: true, approvePermissions: true, sendMessages: true, cancel: true, resume: true };
  const projects: Project[] = [
    { id: "demo:proj", name: "Demo project (simulated)", rootPath: "C:\\demo\\project", objective: "Simulated objective for UI testing", createdAt: now - 60 * min },
  ];
  const sessions: Session[] = [
    {
      id: "demo:sm", projectId: "demo:proj", source: "managed", runtimeSessionId: "demo-runtime-1", title: "Demo managed session",
      cwd: "C:\\demo\\project", model: "claude-sonnet-demo", authSource: "none", billingMode: "subscription", runtimeState: "waiting",
      runtimeStateDetail: "Waiting for interaction", permissionMode: "default", startedAt: now - 40 * min, lastEventAt: now - 20_000,
      endedAt: null, capabilities: caps, claudeCodeVersion: "0.0.0-demo",
    },
    {
      id: "demo:sh", projectId: "demo:proj", source: "vscode-hooks", runtimeSessionId: "demo-runtime-2", title: "Demo VS Code session",
      cwd: "C:\\demo\\project", model: null, authSource: null, billingMode: null, runtimeState: "waiting",
      runtimeStateDetail: "Observed via hooks; interaction happens in the original session", permissionMode: "default",
      startedAt: now - 25 * min, lastEventAt: now - 90_000, endedAt: null,
      capabilities: { answerQuestions: false, approvePermissions: false, sendMessages: false, cancel: false, resume: false }, claudeCodeVersion: null,
    },
  ];
  const base = { parentAgentId: null, runtimeAgentId: null, modelSource: null, currentActionAt: null, endedAt: null, stale: false, subtasks: null, changedFiles: [] as string[], errorCount: 0 };
  const agents: Agent[] = [
    {
      ...base, id: "demo:sm/lead", sessionId: "demo:sm", projectId: "demo:proj", name: "lead", role: "lead", model: "claude-sonnet-demo",
      modelSource: "runtime (init)", status: "waiting", assignedTask: "Refactor the settings module and add tests (simulated brief).",
      currentAction: "Waiting for your answer", currentActionAt: now - 20_000, startedAt: now - 40 * min, lastActivityAt: now - 20_000,
      subtasks: { total: 5, completed: 3, inProgress: 1, source: "TodoWrite" }, changedFiles: ["src/settings.ts", "C:\\demo\\project\\test\\settings.test.ts"],
      lastResult: { text: "Refactored parser; 3 of 5 steps done.", provenance: "agent-reported", ok: null, at: now - 5 * min },
    },
    {
      ...base, id: "demo:sm/w1", sessionId: "demo:sm", projectId: "demo:proj", parentAgentId: "demo:sm/lead", runtimeAgentId: "w1",
      name: "test-runner", role: "tester", model: null, status: "failed", assignedTask: "Run the unit tests", currentAction: null,
      startedAt: now - 30 * min, endedAt: now - 8 * min, lastActivityAt: now - 8 * min, errorCount: 2,
      lastResult: { text: "Command exited with code 1: npm test", provenance: "runtime", ok: false, at: now - 8 * min },
    },
    {
      ...base, id: "demo:sm/w2", sessionId: "demo:sm", projectId: "demo:proj", parentAgentId: "demo:sm/lead", runtimeAgentId: "w2",
      name: "migrator", role: "general-purpose", model: "claude-sonnet-demo", status: "working", stale: true,
      assignedTask: "Migrate config files", currentAction: "Bash: node scripts/migrate.js", currentActionAt: now - 12 * min,
      startedAt: now - 28 * min, lastActivityAt: now - 12 * min,
      lastResult: { text: "Looks fine so far", provenance: "agent-reported", ok: true, at: now - 15 * min },
    },
    {
      ...base, id: "demo:sh/lead", sessionId: "demo:sh", projectId: "demo:proj", name: "lead", role: "lead", model: null, status: "waiting",
      assignedTask: "Update docs (simulated)", currentAction: "Waiting for permission in VS Code", currentActionAt: now - 90_000,
      startedAt: now - 25 * min, lastActivityAt: now - 90_000, lastResult: null,
    },
    {
      ...base, id: "demo:sm/w3", sessionId: "demo:sm", projectId: "demo:proj", parentAgentId: "demo:sm/lead", runtimeAgentId: "w3",
      name: "reviewer", role: "code-reviewer", model: "claude-sonnet-demo", status: "completed", assignedTask: "Review the diff",
      currentAction: null, startedAt: now - 35 * min, endedAt: now - 20 * min, lastActivityAt: now - 20 * min,
      lastResult: { text: "No issues found in the diff.", provenance: "agent-reported", ok: null, at: now - 20 * min },
    },
  ];
  const mkTask = (n: number, title: string, status: Task["status"], blockedBy: string[]): Task => ({
    id: `demo:t${n}`, projectId: "demo:proj", sessionId: "demo:sm", agentId: "demo:sm/lead", externalId: String(n), title, status, blockedBy, source: "TodoWrite", updatedAt: now - 5 * min,
  });
  const tasks: Task[] = [
    mkTask(1, "Read settings module", "completed", []),
    mkTask(2, "Refactor parser", "completed", ["demo:t1"]),
    mkTask(3, "Update callers", "in_progress", ["demo:t2"]),
    mkTask(4, "Run tests", "blocked", ["demo:t3"]),
    mkTask(5, "Write docs", "pending", []),
  ];
  const ix = { projectId: "demo:proj", statusDetail: null, toolUseId: null, response: null, expiresAt: null };
  const interactions: Interaction[] = [
    {
      ...ix, id: "demo:q1", sessionId: "demo:sm", agentId: "demo:sm/lead", kind: "question", status: "pending", interactive: true,
      createdAt: now - 3 * min, updatedAt: now - 3 * min,
      request: {
        type: "question", allowFreeText: true,
        questions: [
          { header: "Format", question: "Which config format should the new settings file use?", multiSelect: false,
            options: [{ label: "JSON", description: "Widely supported, no comments." }, { label: "TOML", description: "Readable, supports comments." }] },
          { header: "Targets", question: "Which environments should be migrated?", multiSelect: true,
            options: [{ label: "dev", description: "Local development" }, { label: "staging", description: "Shared staging" }, { label: "prod", description: "Production (careful)" }] },
        ],
      },
    },
    {
      ...ix, id: "demo:p1", sessionId: "demo:sm", agentId: "demo:sm/w2", kind: "permission", status: "pending", interactive: true,
      createdAt: now - 2 * min, updatedAt: now - 2 * min,
      request: {
        type: "permission", toolName: "Bash", title: "Run migration script", displayName: "Bash", description: "Runs a node script that rewrites config files",
        decisionReason: "Command is not covered by an allow rule", blockedPath: null, command: "node scripts/migrate.js --write", filePath: null,
        cwd: "C:\\demo\\project", input: { command: "node scripts/migrate.js --write", description: "migrate" },
        scopeOptions: [
          { id: "once", label: "Approve once", explanation: "Allow this single call." },
          { id: "session:1", label: "Allow node scripts for this session", explanation: "Future node scripts/* Bash calls in this session will not ask again." },
        ],
      },
    },
    {
      ...ix, id: "demo:r1", sessionId: "demo:sm", agentId: "demo:sm/lead", kind: "review", status: "pending", interactive: true,
      createdAt: now - 4 * min, updatedAt: now - 4 * min,
      request: {
        type: "review", turnOk: true, resultText: "Refactored the parser and updated 4 callers. Tests were not run in this turn.",
        changedFiles: ["src/settings.ts", "src/parser.ts"],
        note: "Accept only records your decision in Agent Monitor. It does not merge, commit, or publish anything.",
      },
    },
    {
      ...ix, id: "demo:ro", sessionId: "demo:sh", agentId: "demo:sh/lead", kind: "permission", status: "pending", interactive: false,
      createdAt: now - 90_000, updatedAt: now - 90_000,
      request: {
        type: "permission", toolName: "Write", title: null, displayName: null, description: null, decisionReason: null, blockedPath: null,
        command: null, filePath: "C:\\demo\\project\\README.md", cwd: "C:\\demo\\project", input: { file_path: "C:\\demo\\project\\README.md", content: "..." },
        scopeOptions: [{ id: "once", label: "Approve once", explanation: "Allow this single call." }],
      },
    },
  ];
  const u = { sessionId: "demo:sm", model: "claude-sonnet-demo", totalTokens: null, measuredAt: now - min };
  const usage: UsageRecord[] = [
    { ...u, id: "demo:u1", agentId: null, source: "sdk-result", sourceNote: "Session total reported by the runtime (simulated)", inputTokens: 12_400, outputTokens: 3_100, cacheReadTokens: 80_000, cacheCreationTokens: 5_000, costEstimateUsd: 0.1234, costBasis: "simulated rate card", includedInParent: false },
    { ...u, id: "demo:u2", agentId: "demo:sm/w2", source: "sdk-task", sourceNote: "Worker usage (simulated)", inputTokens: 4_000, outputTokens: 900, cacheReadTokens: null, cacheCreationTokens: null, costEstimateUsd: null, costBasis: null, includedInParent: true },
    { ...u, id: "demo:u3", agentId: null, sessionId: "demo:sh", model: null, source: "transcript", sourceNote: "Transcript tokens (simulated); no cost available", inputTokens: 2_000, outputTokens: 500, cacheReadTokens: null, cacheCreationTokens: null, costEstimateUsd: null, costBasis: null, includedInParent: false },
  ];
  const ev = (id: number, agentId: string, ts: number, summary: string, status: EventRow["status"]): EventRow => ({
    id, sessionId: agentId.split("/")[0], agentId, ts, kind: "milestone", toolName: null, toolUseId: null, summary, status, milestone: true,
  });
  const milestones = [
    ev(-1, "demo:sm/w1", now - 8 * min, "Test command failed: npm test (exit 1)", "error"),
    ev(-2, "demo:sm/w3", now - 20 * min, "Agent completed", "ok"),
  ];
  // A lead coordinating eight workers, to show the stacked Live activity layout fully populated.
  const team = makeTeam(now, caps);
  return {
    projects: [...projects, team.project], sessions: [...sessions, team.session], agents: [...agents, ...team.agents],
    tasks, interactions, usage: [...usage, ...team.usage], milestones,
  };
}

const TEAM_ROLES = ["designer", "image-processor", "engineer", "evaluator", "security-engineer", "tester", "db-engineer", "a11y-reviewer"];
const TEAM_WORKERS: { status: Agent["status"]; task: string; tokens: number }[] = [
  { status: "working", task: "Scene composition", tokens: 168_300 },
  { status: "working", task: "Image processing", tokens: 116_200 },
  { status: "working", task: "Dialogue typewriter effect", tokens: 129_900 },
  { status: "completed", task: "Evaluation suite", tokens: 136_400 },
  { status: "working", task: "Auth hardening", tokens: 117_900 },
  { status: "completed", task: "Session tests", tokens: 118_200 },
  { status: "waiting", task: "Database migration", tokens: 98_700 },
  { status: "failed", task: "Accessibility audit", tokens: 87_100 },
];

function makeTeam(now: number, caps: Session["capabilities"]) {
  const min = 60_000;
  const project: Project = { id: "demo:team", name: "Team example (simulated)", rootPath: "C:\\Users\\demo\\code\\datenight", objective: "Simulated 8-worker run", createdAt: now - 40 * min };
  const session: Session = {
    id: "demo:team", projectId: "demo:team", source: "managed", runtimeSessionId: "demo-runtime-team", title: "Team example (simulated)",
    cwd: "C:\\Users\\demo\\code\\datenight", model: "claude-fable-5-1", authSource: "none", billingMode: "subscription", runtimeState: "running",
    runtimeStateDetail: null, permissionMode: "default", startedAt: now - 38 * min, lastEventAt: now - 5_000, endedAt: null,
    capabilities: caps, claudeCodeVersion: "0.0.0-demo",
  };
  const base = { sessionId: "demo:team", projectId: "demo:team", modelSource: "runtime (simulated)", currentActionAt: now - 5_000, stale: false, subtasks: null, changedFiles: [] as string[], errorCount: 0, lastResult: null };
  const agents: Agent[] = [
    { ...base, id: "demo:team/lead", parentAgentId: null, runtimeAgentId: null, name: "lead", role: "lead", model: "claude-fable-5-1", status: "working",
      assignedTask: "Ship the date-night app (simulated)", currentAction: "Coordinating workers", startedAt: now - 38 * min, lastActivityAt: now - 5_000, endedAt: null },
    ...TEAM_WORKERS.map((w, i): Agent => ({
      ...base, id: `demo:team/w${i + 1}`, parentAgentId: "demo:team/lead", runtimeAgentId: `w${i + 1}`, name: TEAM_ROLES[i], role: TEAM_ROLES[i],
      model: "claude-opus-5-5", status: w.status, assignedTask: w.task, currentAction: w.task, errorCount: w.status === "failed" ? 1 : 0,
      startedAt: now - (36 - i) * min, lastActivityAt: now - (i + 1) * 7_000, endedAt: w.status === "completed" || w.status === "failed" ? now - (i + 1) * 30_000 : null,
    })),
  ];
  const usage: UsageRecord[] = [
    { id: "demo:team-u", sessionId: "demo:team", agentId: null, source: "sdk-result", sourceNote: "Session total (simulated)", model: "claude-fable-5-1, claude-opus-5-5",
      inputTokens: 40_000, outputTokens: 150_300, cacheReadTokens: 900_000, cacheCreationTokens: 60_000, totalTokens: 150_300, costEstimateUsd: 131.07,
      costBasis: "simulated", includedInParent: false, measuredAt: now - min },
    ...TEAM_WORKERS.map((w, i): UsageRecord => ({
      id: `demo:team-u${i + 1}`, sessionId: "demo:team", agentId: `demo:team/w${i + 1}`, source: "sdk-task", sourceNote: "Worker total (simulated); included in session total",
      model: "claude-opus-5-5", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, totalTokens: w.tokens,
      costEstimateUsd: null, costBasis: null, includedInParent: true, measuredAt: now - min,
    })),
  ];
  return { project, session, agents, usage };
}

// Per-agent log scripts for the team example: [kind, tool, summary].
type Step = ["say" | "ok" | "fail" | "run" | "ask", string, string];
const TEAM_LOGS: Record<string, Step[]> = {
  lead: [["ok", "Bash", "$ npm test"], ["say", "", "Final pass. Dispatching."]],
  w1: [["say", "", "Bokeh behind her. Subtle."], ["run", "Bash", "$ npm test scene"]],
  w2: [["say", "", "Eyes on camera."], ["ok", "Bash", "$ sips -Z 1200 sofia.jpg"]],
  w3: [["ok", "Write", "Write dialogue/typewriter.ts"], ["run", "Bash", "$ npm test dialogue"]],
  w4: [["ok", "Bash", "Test command passed (runtime exit status): $ npm test"], ["ok", "Bash", "$ npm run evals"], ["say", "", "Clarity 98.2% on the eval set."]],
  w5: [["say", "", "Password masked. Sessions last 24h."], ["run", "Edit", "Edit auth/hash.ts"]],
  w6: [["say", "", "0 errors."], ["ok", "Bash", "Test command passed (runtime exit status): $ npm test"]],
  w7: [["ok", "Read", "Read db/schema.sql"], ["ask", "", "Permission requested: $ npm run migrate -- --apply"]],
  w8: [["ok", "Grep", "Grep aria-label"], ["fail", "Bash", "Failed: $ npm run a11y — 3 violations: missing alt text"]],
};

function teamEvents(agentId: string, now: number): EventRow[] {
  const key = agentId.split("/")[1];
  const steps = TEAM_LOGS[key] ?? [];
  const rows: EventRow[] = [];
  let n = 0;
  const row = (kind: string, tool: string | null, summary: string, status: EventRow["status"], tu: string | null): EventRow =>
    ({ id: -1000 - (n++), sessionId: "demo:team", agentId, ts: now - (steps.length * 20 - n * 10) * 1000, kind, toolName: tool, toolUseId: tu, summary, status, milestone: false });
  steps.forEach(([k, tool, summary], i) => {
    const tu = `demo-team-${key}-${i}`;
    if (k === "say") rows.push(row("assistant_text", null, summary, "info", null));
    else if (k === "ask") rows.push(row("permission_request", "Bash", summary, "pending", tu));
    else {
      const start = summary.replace(/^Test command passed \(runtime exit status\): /, "").replace(/^Failed: /, "").split(" — ")[0];
      rows.push(row("tool_start", tool, start, "pending", tu));
      if (k === "ok") rows.push(row("tool_end", tool, summary, "ok", tu));
      if (k === "fail") rows.push(row("tool_fail", tool, summary, "error", tu));
    }
  });
  return rows.reverse(); // newest first, like the events endpoint
}

export function demoEvents(agentId: string, now: number): EventRow[] {
  if (agentId.startsWith("demo:team/")) return teamEvents(agentId, now);
  const mk = (n: number, ago: number, tool: string, summary: string, status: EventRow["status"], detail?: unknown): EventRow => ({
    id: -100 - n, sessionId: agentId.split("/")[0], agentId, ts: now - ago * 1000, kind: "tool", toolName: tool, toolUseId: null,
    summary, status, milestone: false, detail,
  });
  // Same event kinds the backend emits (tool_start / tool_end / tool_fail paired by toolUseId),
  // varied per agent so panes don't look identical. All clearly marked simulated.
  const pair = (n: number, ago: number, tool: string, start: string, end: { kind: "tool_end" | "tool_fail"; summary: string } | null, detail?: unknown): EventRow[] => {
    const tu = `demo-tu-${agentId}-${n}`;
    const rows: EventRow[] = [{ ...mk(n * 2, ago, tool, start, "pending", detail), kind: "tool_start", toolUseId: tu }];
    if (end) rows.unshift({ ...mk(n * 2 + 1, ago - 2, tool, end.summary, end.kind === "tool_fail" ? "error" : "ok", detail), kind: end.kind, toolUseId: tu });
    return rows;
  };
  const say = (n: number, ago: number, text: string): EventRow => ({ ...mk(n * 2, ago, "", text, "info"), kind: "assistant_text", toolName: null });
  const sets: EventRow[][] = [
    [
      ...pair(3, 20, "Bash", "$ node scripts/migrate.js --write (simulated)", null),
      ...pair(2, 120, "Read", "Read src/settings.ts (simulated)", { kind: "tool_end", summary: "Read src/settings.ts" }),
      say(1, 200, "Migrating config files to the new format. (simulated)"),
    ],
    [
      ...pair(3, 40, "Bash", "$ npm test (simulated)", { kind: "tool_fail", summary: "Failed: $ npm test — exit code 1: 2 failing (simulated)" }),
      ...pair(2, 160, "Edit", "Edit src/parser.ts (simulated)", { kind: "tool_end", summary: "Edit src/parser.ts" }),
      say(1, 240, "Updating the parser callers. (simulated)"),
    ],
    [
      ...pair(3, 60, "Bash", "$ npm test (simulated)", { kind: "tool_end", summary: "Test command passed (runtime exit status): $ npm test (simulated)" }),
      ...pair(2, 180, "Write", "Write docs/settings.md (simulated)", { kind: "tool_end", summary: "Write docs/settings.md" }),
      say(1, 260, "Reviewing the diff for the settings module. (simulated)"),
    ],
  ];
  let h = 0;
  for (const c of agentId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return sets[h % sets.length];
}

/** Simulated delivery fails when the response contains the word "fail", so the failure path can be exercised. */
export function demoWouldFail(r: InteractionResponse): boolean {
  return JSON.stringify(r).toLowerCase().includes("fail");
}
