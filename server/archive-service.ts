import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { Session, ArchiveResult } from "../shared/types.ts";
import { readConversation, saveConversation, renderConversation } from "./conversation-archive.ts";

export interface CloseJob {
  id: string; sessionId: string; runtimeSessionId: string; source: Session["source"]; cwd: string;
  lastEventAt: number; expiresAt: number; clientId?: string; result: ArchiveResult;
}
export class ArchiveService {
  private store: Store;
  private cfg: Config;
  private jobs = new Map<string, CloseJob>();
  private busy = new Set<string>();
  private proofs = new Map<string, { session: Session; identities: string[]; hash: string }>();
  constructor(store: Store, cfg: Config) { this.store = store; this.cfg = cfg; }
  quiet(id: string, expected: number): Session {
    const s = this.store.sessions.get(id);
    if (!s || s.lastEventAt !== expected || !["idle", "ended", "failed", "interrupted", "cancelled"].includes(s.runtimeState) ||
      [...this.store.agents.values()].some(a => a.sessionId === id && ["working", "waiting", "blocked"].includes(a.status)) ||
      [...this.store.interactions.values()].some(i => i.sessionId === id && i.kind !== "review" && ["pending", "delivering"].includes(i.status))) {
      throw new Error("Session is active or changed; nothing cleared");
    }
    return s;
  }
  async archive(id: string, expected: number): Promise<ArchiveResult> {
    if (this.busy.has(id)) throw new Error("Session archive is already in progress");
    this.busy.add(id);
    try {
      const session = { ...this.quiet(id, expected) };
      let root;
      try { root = await readConversation(session, this.cfg); }
      catch (e) {
        // The source deleted it; there is nothing left to save or protect.
        if (!(e instanceof Error) || !e.message.startsWith("Original conversation transcript not found")) throw e;
        return { sessionId: id, lastEventAt: expected, archivePath: null, closeStatus: "no_transcript",
          message: "No transcript left on disk, so nothing was saved. Hidden from the monitor; history kept." };
      }
      const conversations = [root];
      // Codex and Kilo workers have independent conversations. Claude tool
      // transcripts are not user/assistant conversation and are not exported.
      if (["codex-local", "kilo-local"].includes(session.source)) {
        for (const a of this.store.agents.values()) if (a.sessionId === id && a.runtimeAgentId) {
          // A worker transcript deleted at the source is skipped; the rest is still saved.
          try { conversations.push(await readConversation({ ...session, runtimeSessionId: a.runtimeAgentId }, this.cfg)); }
          catch (e) { if (!(e instanceof Error) || !e.message.startsWith("Original conversation transcript not found")) throw e; }
        }
      }
      this.quiet(id, expected);
      const archivePath = await saveConversation(session, this.cfg, conversations);
      this.quiet(id, expected);
      const result: ArchiveResult = { sessionId: id, lastEventAt: expected, archivePath, closeStatus: session.source === "managed" ? "not_applicable" : "pending",
        message: session.source === "managed" ? "Conversation saved; this session is hosted by the monitor, not a VS Code tab." : "Conversation saved. Waiting for the VS Code companion to close the linked tab." };
      if (session.source !== "managed") {
        // One pending close per version. A retry can target a newly linked tab.
        for (const [key, job] of this.jobs) if (job.sessionId === id) { this.jobs.delete(key); this.proofs.delete(key); }
        const job: CloseJob = { id: randomUUID(), sessionId: id, runtimeSessionId: session.runtimeSessionId!, source: session.source, cwd: session.cwd,
          lastEventAt: expected, expiresAt: Date.now() + 30000, result };
        result.jobId = job.id; this.jobs.set(job.id, job);
        this.proofs.set(job.id, { session, identities: conversations.map(c => c.runtimeId), hash: createHash("sha256").update(JSON.stringify(conversations)).digest("hex") });
      }
      return result;
    } finally { this.busy.delete(id); }
  }
  pending(): Omit<CloseJob, "result">[] {
    this.expire();
    return [...this.jobs.values()].filter(j => j.result.closeStatus === "pending" && !j.clientId).map(({ result, ...j }) => j);
  }
  private expire() {
    for (const j of this.jobs.values()) if (j.result.closeStatus === "pending" && Date.now() > j.expiresAt) {
      j.result.closeStatus = "unavailable";
      j.result.message = "Saved to vault; tab was not closed. Enable the VS Code companion and link the exact chat tab, then retry Clear finished.";
    }
    // Keep recent receipts for the browser while bounding memory.
    for (const [id, j] of this.jobs) if (Date.now() > j.expiresAt + 300000) { this.jobs.delete(id); this.proofs.delete(id); }
  }
  async claim(id: string, clientId: string): Promise<boolean> {
    this.expire();
    const job = this.jobs.get(id);
    if (!job || job.clientId || job.result.closeStatus !== "pending" || !/^[\w-]{1,100}$/.test(clientId)) return false;
    try { this.quiet(job.sessionId, job.lastEventAt); } catch { job.result.closeStatus = "failed"; job.result.message = "Session resumed; its tab was not closed."; return false; }
    // Reserve before asynchronous source verification so two VS Code windows
    // cannot both close tabs for the same archive job.
    job.clientId = clientId;
    try {
      const proof = this.proofs.get(id)!;
      const conversations = [];
      for (const runtimeSessionId of proof.identities) conversations.push(await readConversation({ ...proof.session, runtimeSessionId }, this.cfg));
      if (createHash("sha256").update(JSON.stringify(conversations)).digest("hex") !== proof.hash ||
        await readFile(job.result.archivePath!, "utf8") !== renderConversation(conversations, proof.session)) throw new Error("changed");
      this.quiet(job.sessionId, job.lastEventAt);
      this.expire();
      return job.result.closeStatus === "pending";
    } catch {
      job.result.closeStatus = "failed"; job.result.message = "Conversation or archive changed; tab was not closed. Retry when the session is finished.";
      return false;
    }
  }
  acknowledge(id: string, clientId: string, closed: boolean, noTab = false): boolean {
    this.expire();
    const job = this.jobs.get(id);
    if (!job || job.clientId !== clientId || job.result.closeStatus !== "pending") return false;
    if (!closed && noTab) {
      job.result.closeStatus = "no_tab";
      job.result.message = "Saved to vault; no open VS Code tab for this session, so nothing to close. History kept.";
      return true;
    }
    job.result.closeStatus = closed ? "closed" : "failed";
    job.result.message = closed ? "Saved to vault and the associated VS Code tab was closed. History kept." : "Saved to vault; VS Code did not close the associated tab. Session remains visible.";
    return true;
  }
  result(id: string): ArchiveResult | null { this.expire(); return this.jobs.get(id)?.result ?? null; }
}
