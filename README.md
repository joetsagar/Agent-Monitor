# Agent Monitor

A Windows desktop app showing live Claude Code and locally logged Codex agents, with the existing Usage-Widget account limits built into the right-hand sidebar. The interface is live-only: compact lead/worker panels, project filtering, Clear finished / Show cleared, and a Needs you tray for existing requests.

## Open the desktop app

Double-click **Agent Monitor.exe** or **start-monitor.bat** in this folder. The app starts the backend hidden if needed; launching it again focuses the existing window. The native **Window** menu offers always-on-top, Refresh, and Close. Closing the window leaves monitoring running; **stop-monitor.bat** stops the backend explicitly.

Keep the executable in this project folder. It bundles the desktop host, uses the installed Node.js 24+ runtime and project dependencies, and requires Microsoft Edge WebView2. The usage integration uses the installed Python and the sibling `Usage-Widget` source folder; the original widget does not need to be running. Rebuild with **build-desktop.bat**. See [desktop/README.md](desktop/README.md) for details.

### Set up from GitHub

This repository contains source and build scripts. Local history, credentials, installed dependencies and generated executables are excluded. Install Node.js 24+, Python 3.13+ and Microsoft Edge WebView2, then clone both projects into the same parent folder:

```powershell
git clone https://github.com/joetsagar/Agent-Monitor.git
git clone https://github.com/joetsagar/Usage-Widget.git
cd Agent-Monitor
npm.cmd install
npm.cmd --prefix web install
.\build-desktop.bat
.\launch-app.bat
```

The sibling Usage-Widget supplies the original icon and account-usage readers. Use your normal Claude/Codex sign-ins on this machine; credentials are not included in either app build. Configuration is optional; when copying `config/agent-monitor.example.json`, adjust `allowedRoots` to your own project folders.

The right-hand **AI Usage** panel reuses Usage-Widget's existing readers: Claude and Codex session/weekly limits and reset times, elapsed-time ticks, and Kilo seven-day tokens. It refreshes every two minutes and retains the last good reading on errors. Credentials remain in the backend/Python reader and are never sent to the web interface. The original standalone Usage-Widget files, details and security popups are preserved.

Claude's **Credits: £…** line beneath Weekly shows the prepaid usage-credit balance, not the remaining monthly spend limit. The monitor reads the same read-only prepaid endpoint found in the installed Claude client; this is an undocumented compatibility interface and may change. If only the balance read fails, the last good balance is labelled **last known**; without a previous balance it shows **Credits: unavailable**. Existing quota windows remain usable.

Monetary displays use GBP. USD amounts are converted using [Frankfurter's daily reference rate](https://frankfurter.dev/), cached locally for 24 hours with its source date shown in the sidebar. The public rate request contains only currency codes, never account data or provider headers. Conversion is an indicative GBP equivalent, not a card/bank settlement rate. If no rate can be obtained, USD costs show **GBP unavailable** rather than relabelling dollars as pounds. Kilo stays tokens-only. Run `npm run test:usage-bridge` for synthetic Python reader tests. Backend changes require a backend restart; closing the desktop window alone leaves that backend running. Web-only changes need a Window → Refresh or reopening the window; no executable rebuild is needed.

The backend remains available at `http://127.0.0.1:4317` if a browser view is useful. Live sessions and allowance bars are separate: token totals in agent panels are session history, while the sidebar shows account allowances.

The dashboard and persistence run locally with no separate monitor account. Allowance and prepaid-credit readers contact the providers using existing local sign-ins; GBP conversion fetches a public exchange rate. The dashboard makes **no model calls** for rendering, event processing, progress or notifications, and it has no AI summaries.

## Claude Code sessions

| | **VS Code / terminal sessions** (observed) | **Managed sessions** (launched from the dashboard) |
|---|---|---|
| How it connects | Claude Code [hooks](https://code.claude.com/docs/en/hooks) forward events to the dashboard (async, one-way) | [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) `query()` running in the backend |
| Live activity, tools, workers, plan | Yes | Yes |
| Answer questions (`AskUserQuestion`) | **No.** Shown read-only; answer in VS Code | Yes, via the SDK `canUseTool` callback |
| Approve or deny permissions | **No.** Shown read-only; answer in VS Code | Yes. *Approve once* or *Deny*; *Approve for this session* only when the runtime proposes a session-scoped rule |
| Send follow-up message, cancel, resume | No (an "Open session" fallback opens the folder and gives you `claude --resume <id>`) | Yes |
| Model identity | From the `SessionStart` hook or the transcript | Reported by the runtime |
| Usage | Summed from the transcript file (**undocumented format**, labelled as such) | Reported by the SDK result message |

Why the VS Code side is read-only: the observation hooks are `async` and never return a decision. Claude Code does document a blocking `PermissionRequest` hook that *could* approve a request, but holding it open would block VS Code's own permission prompt, so it is deliberately not used. There is no screen scraping and no simulated keystrokes.

When a VS Code request is resolved in VS Code, the dashboard marks it **Answered in the original session**.

## Monitor Codex (automatic, read-only)

Start Agent Monitor normally, then work in Codex in a project inside `allowedRoots`. No hooks, API key or extra model calls are needed. The backend reads new JSONL records from `$CODEX_HOME/sessions` (default `~/.codex/sessions`). The header shows **Codex: watching (N)**, or an unavailable message if local logs cannot be read. Hover over it for the last scan time. `N` counts tracked log files, not active agents.

Codex panels show the runtime model, public assistant activity, tool calls, turn completion, and cumulative token usage where recorded. Attributable child threads appear as workers when their logs include a parent thread ID. Plans from `update_plan` calls and file paths from `apply_patch` calls are shown when directly observable. Unknown tool outcomes and costs are not invented. Cached input is separated from input tokens; child usage is conservatively excluded from aggregate totals because it may overlap the parent.

This observes existing local sessions; the desktop interface has no session launcher. Ask questions, grant permissions, send messages and cancel work in the original Codex window. The observer never resumes or modifies Codex sessions. Monitoring itself has no model cost. Cloud sessions and clients that do not write local logs are not visible.

Local rollout files are an **undocumented compatibility format**. Fields can change across Codex versions. The observer ignores reasoning records, analysis messages, instructions, user prompt bodies and raw tool output; existing secret redaction still applies. Long stored text remains bounded. A crashed client may leave a session marked working until it becomes stale.

Optional configuration (merge into `config/agent-monitor.json`):

```json
"codex": {
  "enabled": true,
  "pollIntervalMs": 1000,
  "lookbackDays": 2,
  "maxFiles": 40
}
```

Set `sessionsDir` inside this object to override the log directory. Discovery runs about every five seconds and watches the most recently modified files within the lookback window; known files are read incrementally each poll. Increase `lookbackDays` if an ongoing session's file has an old modification time. Disable with `"enabled": false`. Restart the backend after configuration changes; restarting ends backend-managed Claude sessions, so finish or cancel them first. Persisted monitor history is retained.

The supported [Codex app-server protocol](https://developers.openai.com/codex/app-server) is available for building a future managed Codex launcher. This integration uses local observation so it can see work in an already-running Codex client without taking over that session.

## Start and stop (Windows PowerShell)

First-time setup:

```powershell
cd "C:\Users\joets\VS Code Dev\Agent Monitor"
npm install
cd web; npm install; npm run build; cd ..
```

Start (runs in the background and opens the browser):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Stop (ends managed sessions cleanly; your VS Code sessions are unaffected):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

You can also run it in the foreground with `npm start` (Ctrl+C to stop). Logs are written to `data\server.log`.

Closing or refreshing the browser never stops agent work. Managed sessions belong to the backend, so stopping the **backend** ends them. Pending managed requests then show as **Expired**, and you can resume the session later by sending it a message.

## Monitor your VS Code sessions

Install the observation hooks once:

```powershell
# All Claude Code sessions for your user (writes ~/.claude/settings.json; a backup is made first)
node scripts\install-hooks.mjs --user
# ...or only one project (writes <dir>\.claude\settings.local.json)
node scripts\install-hooks.mjs --project "C:\path\to\project"
# Remove them again
node scripts\install-hooks.mjs --user --uninstall
```

Then start a new Claude Code session, or reload the VS Code window. The forwarder (`hooks/forward.mjs`) sends no output, always exits 0, and gives up after 1.5 s. If the dashboard isn't running, Claude Code is unaffected.

## Existing managed sessions (legacy backend support)

The live-only app does not launch new managed sessions. Existing backend-managed Claude sessions retain their question, permission, review and follow-up controls through **Needs you** and the agent detail drawer. Backend/API support remains available for existing integrations; managed folders must stay inside `allowedRoots`, and the runtime's permission rules are never bypassed.

How interaction states work:

- **Sending**: the browser is posting your answer.
- **Delivered**: the backend handed it to the exact pending SDK callback, matched by its request, session, agent and tool-use IDs.
- **Agent continued**: the runtime emitted the follow-up tool result for that request. A response counts as resumed only after this happens.
- **Failed**: the callback no longer exists, for example because the session ended. Your typed draft is kept.
- **Expired**: the backend restarted while the request was pending.

A duplicate click is rejected, and a network retry of the same submission is handled idempotently.

**Reviews**: when a managed turn ends, and no workers are still running, a review request appears. *Accept* only records your decision; it does not merge, commit or publish anything. *Request changes* sends your text to the agent as a new message.

## Billing and configuration

Copy `config\agent-monitor.example.json` to `config\agent-monitor.json` to change settings.

- `billingMode: "subscription"` (default) runs managed sessions on your existing Claude Code login. The backend removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment. It **stops a session** if the runtime reports any auth source other than `none` or `oauth`, so it can never silently switch to paid API usage. You chose this mode. Note that the Agent SDK documentation says third-party *products* should use API keys rather than claude.ai login; this tool is for personal local use.
- `billingMode: "api"` uses an Anthropic Console key from `.env` (`ANTHROPIC_API_KEY=...`, git-ignored, read only by the backend). The session is stopped unless the runtime reports `ANTHROPIC_API_KEY` as its auth source.
- `defaultModel`: an alias (`sonnet`, `haiku`, `opus`) or a full model ID. The runtime reports the model it resolved to; `haiku` resolved to `claude-haiku-5-5` during testing.
- `pricing.models`: per-million-token rates keyed by model-ID prefix, plus `asOf`. These are used only for hook-observed sessions. With no rates configured, their cost shows as **Unknown**. For managed sessions the dashboard shows the SDK's own computed cost, labelled as an *API-equivalent estimate, not a subscription charge*.
- `allowedRoots`: managed sessions and file links are restricted to these folders.
- `staleAfterMs`: how long a "working" agent can go without events before it is flagged as stale.

How usage is counted: input, output, cache-read and cache-write tokens are kept separate. Worker totals reported by the SDK are marked *included in session total* and never added again. For hook sessions, lead and worker transcripts are separate files, and testing confirmed they have no overlapping messages.

## Security

- The server binds to `127.0.0.1` only. It rejects foreign `Host` headers (DNS-rebinding protection) and cross-origin writes, and sends no CORS headers.
- A random token in `data\token` is required for every API call and for hook ingestion. The browser gets the token from a same-origin-only bootstrap endpoint.
- Provider credentials stay in the backend process environment and are never sent to the browser.
- File paths reported by agents become `vscode://` links only when they resolve inside the session folder or `allowedRoots`; anything else is shown as plain text.
- Common secret formats are redacted from events before they are stored or shown. Tool output is rendered as plain text, and a strict CSP is applied.

## Development

```powershell
npm start                # backend (Node 24 runs the TypeScript directly)
npm run dev              # Vite dev server on :5173, proxies /api to :4317
npm run typecheck
npm test                 # backend tests (no model calls)
node scripts\e2e-proof.mjs haiku   # REAL session: question + approve + deny round trip (small usage)
node scripts\e2e-multi.mjs haiku   # REAL session: worker attribution + usage accounting (small usage)
node scripts\ui-check.mjs <outDir>              # drives headless Edge through demo mode (no usage)
node scripts\codex-ui-check.mjs <outDir>         # checks an already-active local Codex session in the UI (no model calls)
node scripts\desktop-ui-check.mjs <outDir>       # live-only layout, sidebar and requests; reads current usage (no model calls)
```

The older `ui-real-proof.mjs` and `ui-reliability.mjs` scripts target the removed session-launch form. Use `desktop-ui-check.mjs` and `ui-check.mjs` for the current live-only interface; API-level runtime checks remain available above.

Open `http://127.0.0.1:4317/?demo=1` to see every interaction type with clearly labelled **simulated** data. Simulated items have ids starting `demo:` and never reach the server; include the word "fail" in a text field to exercise the failed-delivery path.

Layout: `server/` holds the backend. Adapters live in `hooks-adapter.ts` (observation) and `managed-adapter.ts` (SDK); runtime-neutral state is in `store.ts`. `shared/types.ts` is the contract between backend and UI, `web/` is the React UI, `hooks/forward.mjs` is the hook forwarder and `scripts/` has the start, stop and test scripts. To add another agent runtime, write a new adapter that produces the same normalized events and interactions.

## Known limitations

- VS Code sessions are observe-only (see above). `AskUserQuestion` is not available inside subagents, which is an SDK limitation.
- If a VS Code session dies without a `SessionEnd` hook, its read-only requests stay pending. Its agents are flagged **stale** after `staleAfterMs`.
- Transcript-based usage depends on an undocumented file format and may break when Claude Code updates. It then shows **Unknown** rather than wrong numbers.
- Hooks don't report a test's pass or fail details, only the command's exit status. Results are labelled *runtime result* (exit status) or *agent-reported* (the agent's own text). Neither is an independent check unless you accept a review.
- A backend restart cannot keep a pending SDK callback alive. Those requests become **Expired**, and the session is marked *interrupted* and can be resumed by sending it a message.

## Clear old sessions from the display

Click **Clear finished** in the top bar to hide finished or idle sessions in the selected project, including their old requests and usage. Active agents are kept visible. This only changes the display in this browser, persists across refresh/restart, and preserves history. **Show cleared** restores them; new session activity also makes them visible again.

### Kilo CLI session observation

The read-only Kilo watcher polls `~/.local/share/kilo/kilo.db` every two seconds. It imports session/model/state metadata and attributable child sessions under `allowedRoots`. The header reports watching, unavailable or disabled; Kilo panels use the Kilo logo and read-only labels. Questions, permissions and messages remain in Kilo. No prompts, reasoning, tool arguments, outputs or session titles are imported. Token totals remain in the existing usage sidebar.

Configure `kilo: { enabled, databasePath, pollIntervalMs, lookbackDays, maxSessions }` in the monitor config; defaults are enabled, two seconds, seven days and 100 sessions (capped at 500). Set `AGENT_MONITOR_KILO_ENABLED=0` to disable. This observes the CLI SQLite format, not VS Code extension storage. Finished assistant messages become idle; unfinished activity older than `staleAfterMs` becomes interrupted with an unknown-state explanation. Database records cannot prove that a process is still running or waiting for approval. Archived sessions end. Unsupported/missing/busy databases report unavailable without exposing database errors.

### Clear finished: save conversation, close its tab, keep history

**Clear finished** now exports each eligible session's complete available user/assistant text from the original local transcript, verifies the saved file, asks the VS Code companion to close its associated editor tab, and then hides successful sessions. Original agent history is kept. Sessions whose original transcript no longer exists are hidden with a note that nothing was saved. Codex sessions with no log activity for 6 hours are treated as interrupted so they can be cleared. Active sessions, failed vault writes, changed conversations and open tabs that cannot be identified remain visible. A saved session with no possibly-matching open tab (no Codex tab with its ID; no unlinked Claude/Kilo chat tab) is hidden, since there is nothing to close with a per-session explanation. Unavailable companions time out after 30 seconds; already saved notes are kept and retries reuse identical notes.

Notes go to `AIWorkspace/Brain/AI History/Monitor Archives/<provider>/` by default. Configure `archiving.vaultPath` to select another existing vault, `archiving.claudeProjectsDir` for Claude transcript storage, and `codex.archivedSessionsDir` for relocated archived Codex logs. Notes are immutable and content-addressed: manual edits and imported history are never overwritten. User/assistant text is not summarised or truncated. Private reasoning, system messages, raw tool logs and binary attachments are excluded; common credential formats are redacted. Codex/Kilo worker conversations are included; an unavailable worker transcript prevents clearing the session. The archive reflects what is available in local logs, not messages already removed by the source agent.

Install the local VS Code companion (no marketplace or account required):

```powershell
python scripts/package-vscode-companion.py
code --install-extension "dist/agent-monitor-companion.vsix" --force
```

Reload VS Code once after installation and refresh Agent Monitor. Codex custom editor tabs are matched by exact session URI. For a dedicated Claude or Kilo editor tab, run **Agent Monitor: Link This Chat Tab to a Session** from the Command Palette and choose its exact session ID before clearing. These providers do not expose a session ID through the public VS Code tab API; the explicit link supplies that identity. Links are forgotten when the tab changes, closes, or VS Code reloads. Relink if you switch conversations inside a webview. Sidebars, terminals and shared Kilo Agent Manager views are not closed; use a dedicated chat editor tab instead. Dirty tabs and unrelated tabs are left alone. The companion never runs provider-wide "close all" or deletes history.

If discovery fails, set **Agent Monitor: Root** in VS Code settings to the monitor repository path. Custom runtime `AGENT_MONITOR_CONFIG`/port/data environment overrides must also be reflected in the repository's configuration for the companion to connect. Managed Claude sessions run inside the monitor rather than VS Code: after saving they are ended and hidden without a tab-close request. Archive/close endpoints use the same local authentication and origin checks as other state-changing operations. A source/receipt recheck immediately before granting the close request prevents closing a session that resumed during export; changes after that instant remain subject to the usual observer/polling delay.
