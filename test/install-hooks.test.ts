// install-hooks.mjs against a temp settings file (via AGENT_MONITOR_SETTINGS_FILE); never touches ~/.claude.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-hooks.mjs");
const dir = mkdtempSync(join(tmpdir(), "am-hooks-"));
const file = join(dir, "settings.json");

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, "--user", ...args], { env: { ...process.env, AGENT_MONITOR_SETTINGS_FILE: file }, encoding: "utf8" });
}
const read = () => JSON.parse(readFileSync(file, "utf8"));

test("install is idempotent, keeps other hooks, and uninstall removes only ours", () => {
  writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }));
  assert.equal(run().status, 0);
  const once = read();
  assert.equal(once.theme, "dark");
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.SessionStart.length, 1);
  assert.equal(run().status, 0);
  assert.deepEqual(read(), once);
  assert.equal(run("--uninstall").status, 0);
  const after = read();
  assert.deepEqual(after.hooks, { Stop: [{ hooks: [{ type: "command", command: "other" }] }] });
});

test("invalid JSON gives a friendly error and leaves the file alone", () => {
  writeFileSync(file, "{ nope");
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cannot parse/);
  assert.equal(readFileSync(file, "utf8"), "{ nope");
});
