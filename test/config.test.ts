// Config validation and token handling against throwaway directories.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadToken } from "../server/config.ts";

const dir = mkdtempSync(join(tmpdir(), "am-config-"));

function load(user: unknown, env: Record<string, string> = {}) {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(user));
  const saved = { ...process.env };
  Object.assign(process.env, { AGENT_MONITOR_CONFIG: file, AGENT_MONITOR_DATA: join(dir, "data"), ...env });
  try { return loadConfig(); } finally {
    for (const k of ["AGENT_MONITOR_CONFIG", "AGENT_MONITOR_DATA", "AGENT_MONITOR_PORT"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test("accepts a valid config", () => {
  const c = load({ port: 4400, allowedRoots: [dir] });
  assert.equal(c.port, 4400);
});

test("rejects bad allowedRoots", () => {
  assert.throws(() => load({ allowedRoots: "not-an-array" }), /allowedRoots must be an array of strings/);
  assert.throws(() => load({ allowedRoots: [1] }), /allowedRoots must be an array of strings/);
});

test("rejects bad ports", () => {
  for (const port of [0, 70000, 1.5, "4317"]) assert.throws(() => load({ port }), /port must be an integer/);
  assert.throws(() => load({}, { AGENT_MONITOR_PORT: "abc" }), /port must be an integer/);
});

test("loadToken regenerates empty or short tokens and keeps good ones", () => {
  const d = mkdtempSync(join(tmpdir(), "am-token-"));
  writeFileSync(join(d, "token"), "  \n");
  const t1 = loadToken(d);
  assert.ok(t1.length >= 32);
  assert.equal(readFileSync(join(d, "token"), "utf8"), t1);
  assert.equal(loadToken(d), t1);
  writeFileSync(join(d, "token"), "short");
  assert.notEqual(loadToken(d), "short");
});
