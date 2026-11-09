import type { ArchiveService } from "./archive-service.ts";
import type { HooksAdapter } from "./hooks-adapter.ts";
import type { Store } from "./store.ts";

export interface ClearReport { at: number; archived: number; failed: string[]; removed: number; kept: number }

// Handles Claude Code's SessionStart hook with source "clear" (the user typed
// /clear): archive every session to the vault, then wipe all agent information
// and raise the clear watermark so nothing old comes back.
export class ClearService {
  private store: Store;
  private archives: ArchiveService;
  private hooks: HooksAdapter;
  private running: Promise<ClearReport> | null = null;
  constructor(store: Store, archives: ArchiveService, hooks: HooksAdapter) { this.store = store; this.archives = archives; this.hooks = hooks; }

  // Strictly newer than the watermark, so a duplicated delivery cannot wipe the new chat.
  isTrigger(body: { ts?: number; payload?: Record<string, any> }): boolean {
    const p = body?.payload;
    return p?.hook_event_name === "SessionStart" && p.source === "clear" && typeof p.session_id === "string" &&
      (Number.isFinite(body.ts) ? Number(body.ts) : Date.now()) > this.store.clearedAt;
  }

  run(at: number): Promise<ClearReport> {
    return this.running ??= this.doRun(at).finally(() => { this.running = null; });
  }

  private async doRun(at: number): Promise<ClearReport> {
    // Managed sessions whose runtime is genuinely running are not killed or wiped:
    // removing them would orphan the live run. They stay until they finish.
    const live = (s: { source: string; runtimeState: string }) => s.source === "managed" && ["starting", "running", "waiting"].includes(s.runtimeState);
    const failed: string[] = []; let archived = 0;
    for (const s of [...this.store.sessions.values()]) {
      if (live(s) || s.lastEventAt >= at) continue;
      try { await this.archives.archive(s.id, s.lastEventAt, { force: true, closeTab: false }); archived++; }
      catch (e) { failed.push(`${s.title}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const { removed, kept } = this.store.clearAll(at, live);
    this.hooks.reset();
    return { at, archived, failed, removed, kept };
  }
}
