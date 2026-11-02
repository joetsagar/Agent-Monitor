// Shared contract between the Agent Monitor backend and browser UI.
// Runtime state, task progress, interactions and review decisions are kept
// as separate entities; the UI derives presentation from them.

export type SessionSource = "vscode-hooks" | "managed" | "codex-local" | "kilo-local";

export interface ArchiveResult {
  sessionId: string;
  lastEventAt: number;
  archivePath: string | null;
  closeStatus: "pending" | "closed" | "no_tab" | "no_transcript" | "not_applicable" | "unavailable" | "failed";
  message: string;
  jobId?: string;
}

export interface WidgetUsageRow {
  label: string;
  percent: number | null;
  tokens: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
  credits: number | null;
  creditsStale?: boolean;
}
export interface WidgetUsageProvider {
  id: "claude" | "codex" | "kilo";
  name: string;
  status: "loading" | "ok" | "error";
  error: string | null;
  rows: WidgetUsageRow[];
  stale: boolean;
}
export interface WidgetUsageSnapshot {
  exchangeRate?: { usdToGbp: number; asOf: string } | null;
  updatedAt: number | null;
  refreshing: boolean;
  providers: WidgetUsageProvider[];
}

export type RuntimeState =
  | "starting"
  | "running"
  | "idle" // turn finished, session still open for input
  | "waiting" // blocked on a pending interaction
  | "ended"
  | "failed"
  | "interrupted" // backend lost the runtime (restart/crash); can be resumed
  | "cancelled";

export type AgentStatus =
  | "working"
  | "waiting"
  | "blocked"
  | "idle"
  | "failed"
  | "completed"
  | "cancelled";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  objective: string | null; // user-entered; never generated
  createdAt: number;
}

export interface SessionCapabilities {
  answerQuestions: boolean;
  approvePermissions: boolean;
  sendMessages: boolean;
  cancel: boolean;
  resume: boolean;
}

export interface Session {
  id: string;
  projectId: string;
  source: SessionSource;
  runtimeSessionId: string | null;
  title: string;
  cwd: string;
  model: string | null; // as reported by the runtime; null = Unknown
  authSource: string | null; // runtime-reported apiKeySource, managed only
  billingMode: "subscription" | "api" | null; // managed only
  runtimeState: RuntimeState;
  runtimeStateDetail: string | null;
  permissionMode: string | null;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  capabilities: SessionCapabilities;
  claudeCodeVersion: string | null;
}

export type ResultProvenance =
  | "agent-reported" // text the agent wrote
  | "runtime" // exit status / tool result from the runtime
  | "user-checked"; // a user review decision

export interface AgentResult {
  text: string;
  provenance: ResultProvenance;
  ok: boolean | null; // null = not determined
  at: number;
}

export interface SubtaskProgress {
  total: number;
  completed: number;
  inProgress: number;
  source: string; // e.g. "TodoWrite" — only present when the agent defined subtasks
}

export interface Agent {
  id: string;
  sessionId: string;
  projectId: string;
  parentAgentId: string | null;
  runtimeAgentId: string | null;
  name: string;
  role: string; // "lead" or the subagent type
  model: string | null;
  modelSource: string | null;
  status: AgentStatus;
  assignedTask: string | null;
  currentAction: string | null;
  currentActionAt: number | null;
  lastResult: AgentResult | null;
  lastActivityAt: number;
  startedAt: number;
  endedAt: number | null;
  stale: boolean; // derived: active status but no events within the stale threshold
  subtasks: SubtaskProgress | null;
  changedFiles: string[];
  errorCount: number;
}

export interface Task {
  id: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  externalId: string; // id/index from the runtime tool
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "deleted";
  blockedBy: string[];
  source: string;
  updatedAt: number;
}

export type EventStatus = "ok" | "error" | "info" | "pending";

export interface EventRow {
  id: number;
  sessionId: string;
  agentId: string;
  ts: number;
  kind: string;
  toolName: string | null;
  toolUseId: string | null;
  summary: string;
  status: EventStatus;
  milestone: boolean;
  detail?: unknown; // redacted, truncated payload; only in per-agent event queries
}

export type InteractionKind = "question" | "permission" | "review";

export type InteractionStatus =
  | "pending"
  | "delivering"
  | "delivered" // handed to the runtime callback
  | "resumed" // runtime emitted a follow-up event for this request
  | "failed"
  | "expired"
  | "cancelled"
  | "answered_elsewhere" // resolved in the original session (VS Code)
  | "decided"; // review decisions (no runtime delivery involved)

export interface QuestionItem {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface QuestionRequest {
  type: "question";
  questions: QuestionItem[];
  allowFreeText: boolean;
}

export interface PermissionScopeOption {
  id: string; // "once" or "session:<n>"
  label: string;
  explanation: string;
}

export interface PermissionRequestPayload {
  type: "permission";
  toolName: string;
  title: string | null;
  displayName: string | null;
  description: string | null;
  decisionReason: string | null;
  blockedPath: string | null;
  command: string | null;
  filePath: string | null;
  cwd: string;
  input: unknown; // redacted
  scopeOptions: PermissionScopeOption[]; // always includes "once"
}

export interface ReviewRequest {
  type: "review";
  resultText: string;
  changedFiles: string[];
  turnOk: boolean;
  note: string; // explains that Accept only records a decision
}

export type InteractionRequest = QuestionRequest | PermissionRequestPayload | ReviewRequest;

export type InteractionResponse =
  | { type: "question"; answers: Record<string, string | string[]> }
  | { type: "permission"; decision: "approve" | "deny"; scope?: string; message?: string }
  | { type: "review"; decision: "accept" | "request_changes"; message?: string };

export interface Interaction {
  id: string;
  sessionId: string;
  agentId: string;
  projectId: string;
  kind: InteractionKind;
  status: InteractionStatus;
  statusDetail: string | null;
  interactive: boolean; // false when it can only be answered in the original session
  toolUseId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  request: InteractionRequest;
  response: InteractionResponse | null;
  clientRequestId?: string | null; // last accepted submission, for idempotent retries
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  agentId: string | null;
  source: "sdk-result" | "transcript" | "sdk-task" | "codex-transcript";
  sourceNote: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  costEstimateUsd: number | null;
  costBasis: string | null; // which rates produced the estimate
  includedInParent: boolean; // true = already counted in the session total; never add again
  measuredAt: number;
}

export interface ServerInfo {
  kilo?: { enabled: boolean; status: "watching" | "unavailable" | "disabled"; sessionsTracked: number; lastScanAt: number | null; error: string | null };
  codex?: { enabled: boolean; status: "watching" | "unavailable" | "disabled"; filesTracked: number; lastScanAt: number | null; lastEventAt: number | null; error: string | null };
  startedAt: number;
  version: string;
  billingMode: "subscription" | "api";
  managedSessionsEnabled: boolean;
  hooksEventsReceived: number;
  lastHookEventAt: number | null;
  staleAfterMs: number;
  aiSummaries: false;
}

export interface Snapshot {
  server: ServerInfo;
  projects: Project[];
  sessions: Session[];
  agents: Agent[];
  tasks: Task[];
  interactions: Interaction[];
  milestones: EventRow[];
  usage: UsageRecord[];
}

// Server-sent event messages. A "snapshot" replaces client state entirely
// (sent on every (re)connect); other messages upsert single entities.
export type StreamMessage =
  | { type: "snapshot"; data: Snapshot }
  | { type: "project"; data: Project }
  | { type: "session"; data: Session }
  | { type: "agent"; data: Agent }
  | { type: "task"; data: Task }
  | { type: "interaction"; data: Interaction }
  | { type: "event"; data: EventRow }
  | { type: "usage"; data: UsageRecord }
  | { type: "server"; data: ServerInfo };

export interface StartSessionRequest {
  projectPath: string;
  prompt: string;
  model?: string; // alias or full id; default from config
  permissionMode?: "default" | "plan" | "acceptEdits";
  title?: string;
  loadSettings?: boolean; // load user/project Claude settings (CLAUDE.md, hooks, skills)
}
