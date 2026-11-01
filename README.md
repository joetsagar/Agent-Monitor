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

The backend remains available at `http://127.0.0.1:4317` if a browser view is useful. Live sessions and allowance bars are separate: token totals in agent panels are session history, while the sidebar shows account allowances.

Everything runs locally. There are no accounts and no cloud services. The dashboard makes **no model calls** for rendering, event processing, progress or notifications, and it has no AI summaries.

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
