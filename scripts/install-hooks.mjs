// Installs or removes Agent Monitor's observation hooks in Claude Code settings.
//   node scripts/install-hooks.mjs --user                 (~/.claude/settings.json: all sessions)
//   node scripts/install-hooks.mjs --project <dir>        (<dir>/.claude/settings.local.json)
//   add --uninstall to remove. A timestamped backup is written before changes.
// Hooks are async observers: they never block, approve or deny anything.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const pi = args.indexOf("--project");
let file;
if (args.includes("--user")) file = join(homedir(), ".claude", "settings.json");
else if (pi >= 0 && args[pi + 1]) file = join(resolve(args[pi + 1]), ".claude", "settings.local.json");
else { console.error("Specify --user or --project <dir>"); process.exit(2); }

const forwarder = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "forward.mjs").replace(/\\/g, "/");
const MARK = "agent-monitor";
const command = `node "${forwarder}" --${MARK}`;
const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "TaskCompleted"];

mkdirSync(dirname(file), { recursive: true });
const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
if (existsSync(file)) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, backup);
  console.log("Backup:", backup);
}
settings.hooks ??= {};
for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").includes(`--${MARK}`)) }))
    .filter((g) => g.hooks.length > 0);
  if (!uninstall) groups.push({ hooks: [{ type: "command", command, async: true, timeout: 5 }] });
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log(`${uninstall ? "Removed" : "Installed"} Agent Monitor hooks in ${file}`);
if (!uninstall) console.log("Start a new Claude Code session (or reload VS Code) for the hooks to take effect.");
