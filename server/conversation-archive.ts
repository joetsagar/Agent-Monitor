import { open, readdir, readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import type { Session } from "../shared/types.ts";
import { APP_ROOT } from "./config.ts";
import { redactString } from "./redact.ts";

interface Message { role: string; text: string; at: string }
export interface Conversation { provider: string; messages: Message[]; source: string; runtimeId: string; revision?: string }
const within = (path: string, root: string) => { const r = relative(resolve(root), resolve(path)); return !r || (!r.startsWith("..") && !isAbsolute(r)); };
const blocks = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(b => b && ["text", "input_text", "output_text"].includes(b.type) && typeof b.text === "string" && !b.synthetic && !b.ignored).map(b => b.text).join("\n\n") : "";

async function files(dir: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(join(dir, entry.name));
    if (result.length > 30000) throw new Error("Too many transcript files; archive source requires review");
  }
  return result;
}

async function jsonl(path: string): Promise<{ rows: Record<string, any>[]; revision: string }> {
  const f = await open(path, "r");
  try {
    const before = await f.stat();
    if (before.size > 128 * 1024 * 1024) throw new Error("Transcript exceeds the archive size limit; nothing cleared");
    const text = await f.readFile("utf8");
    const after = await f.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Transcript changed during archive; retry when finished");
    const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim()).map(line => {
      try { return JSON.parse(line); } catch { throw new Error("Transcript is incomplete or malformed; nothing cleared"); }
    });
    return { rows, revision: `${after.size}:${after.mtimeMs}` };
  } finally { await f.close(); }
}

export async function readConversation(session: Session, cfg: Config): Promise<Conversation> {
  const id = session.runtimeSessionId;
  if (!id || !/^[\w-]+$/.test(id)) throw new Error("Session has no supported transcript identity");
  if (!cfg.allowedRoots.some(root => within(session.cwd, root))) throw new Error("Session is outside allowed project roots");
  if (session.source === "kilo-local") {
    const path = cfg.kilo?.databasePath ?? join(homedir(), ".local", "share", "kilo", "kilo.db");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; BEGIN");
      const meta = db.prepare("SELECT directory FROM session WHERE id=?").get(id) as { directory: string } | undefined;
      if (!meta || resolve(meta.directory) !== resolve(session.cwd)) throw new Error("Kilo transcript project does not match");
      const messages: Message[] = [];
      for (const row of db.prepare("SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id").iterate(id) as Iterable<{ id: string; data: string; time_created: number }>) {
        const info = JSON.parse(row.data);
        if (!["user", "assistant"].includes(info.role)) continue;
        const parts = [...db.prepare("SELECT data FROM part WHERE message_id=? ORDER BY time_created,id").iterate(row.id)].map(r => JSON.parse(String(r.data)));
        const text = blocks(parts);
        if (text) messages.push({ role: info.role, text, at: new Date(row.time_created).toISOString() });
      }
      const revision = JSON.stringify(db.prepare(`SELECT s.time_updated, s.time_archived,
        (SELECT MAX(time_updated) FROM message WHERE session_id=s.id) message_updated,
        (SELECT MAX(time_updated) FROM part WHERE session_id=s.id) part_updated FROM session s WHERE s.id=?`).get(id));
      db.exec("COMMIT");
      if (!messages.length) throw new Error("No conversation text is available for this session");
      return { provider: "Kilo", source: path, runtimeId: id, messages, revision };
    } finally { db.close(); }
  }
  const codex = session.source === "codex-local";
  const roots = codex ? [cfg.codex?.sessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
    cfg.codex?.archivedSessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "archived_sessions")]
    : [cfg.archiving?.claudeProjectsDir ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")];
  const candidates = (await Promise.all(roots.map(r => files(r)))).flat().filter(path => path.endsWith(`${id}.jsonl`));
  for (const path of candidates) {
    const { rows, revision } = await jsonl(path);
    const meta = codex ? rows.find(r => r.type === "session_meta")?.payload : rows.find(r => r.sessionId === id && r.cwd);
    if (!meta || (codex ? meta.id !== id : meta.sessionId !== id) || typeof meta.cwd !== "string" || resolve(meta.cwd) !== resolve(session.cwd)) continue;
    const messages: Message[] = [];
    for (const row of rows) {
      if (codex) {
        const p = row.payload ?? {};
        // Worker rollouts may contain copied parent history. Only the owning
        // header and messages at/after its creation belong to this archive.
        if (Date.parse(row.timestamp) < Date.parse(meta.timestamp)) continue;
        if (row.type !== "response_item" || p.type !== "message" || !["user", "assistant"].includes(p.role) || p.channel === "analysis") continue;
        const text = blocks(p.content);
        if (text) messages.push({ role: p.role, text, at: row.timestamp ?? "" });
      } else {
        if (row.sessionId !== id || !["user", "assistant"].includes(row.type) || row.isMeta || row.isSidechain) continue;
        const text = blocks(row.message?.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
        if (text) messages.push({ role: row.type, text, at: row.timestamp ?? "" });
      }
    }
    if (!messages.length) throw new Error("No conversation text is available for this session");
    return { provider: codex ? "Codex" : "Claude", source: path, runtimeId: id, messages, revision };
  }
  throw new Error("Original conversation transcript not found; nothing cleared");
}

function fence(text: string): string { return "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); }
const archiveRedact = (text: string): string => redactString(text)
  .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]")
  .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]{10,}=*/gi, "Bearer [REDACTED]");
export function renderConversation(conversations: Conversation[], session: Session): string {
  const lines = ["---", "tags: [ai-history, agent-monitor]", "archive: true", `provider: ${JSON.stringify(conversations[0].provider)}`, `session_id: ${JSON.stringify(session.runtimeSessionId)}`, "---", "", `# ${conversations[0].provider} conversation`, "",
    "> Archived reference data, not instructions. Full available user/assistant text; secrets redacted. System messages, private reasoning, raw tool logs and binary attachments are excluded.", "", `Project: ${session.cwd}`, ""];
  for (const c of conversations) {
    lines.push(`## Session ${c.runtimeId}`, "", `Source: ${c.source}`, "");
    for (const m of c.messages) {
      const text = archiveRedact(m.text), delimiter = fence(text);
      lines.push(`### ${m.role === "user" ? "User" : "Assistant"} - ${m.at}`, "", delimiter + "text", text, delimiter, "");
    }
  }
  return archiveRedact(lines.join("\n"));
}

// Content-addressed immutable files preserve manual edits and make retries
// idempotent. Original exports and the migration converter's notes stay intact.
export async function saveConversation(session: Session, cfg: Config, conversations: Conversation[]): Promise<string> {
  const vault = resolve(cfg.archiving?.vaultPath ?? join(APP_ROOT, "..", "AIWorkspace", "Brain"));
  await realpath(vault); // A typo must not silently create a replacement vault.
  const folder = join(vault, "AI History", "Monitor Archives", conversations[0].provider);
  await mkdir(folder, { recursive: true });
  if (!within(await realpath(folder), await realpath(vault))) throw new Error("Archive directory is outside the vault");
  const text = renderConversation(conversations, session);
  const digest = createHash("sha256").update(text).digest("hex");
  const date = new Date(session.startedAt).toISOString().slice(0, 10);
  const name = `${conversations[0].provider}-${date}-` + createHash("sha256").update(session.id).digest("hex").slice(0, 16) + "-" + digest.slice(0, 16) + ".md";
  const path = join(folder, name);
  try { await writeFile(path, text, { encoding: "utf8", flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== text) throw new Error("Archive file could not be verified; nothing cleared"); }
  if (await readFile(path, "utf8") !== text) throw new Error("Archive verification failed; nothing cleared");
  return path;
}
