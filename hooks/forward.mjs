#!/usr/bin/env node
// Claude Code hook forwarder for Agent Monitor. Reads the hook JSON from
// stdin, stamps the fire time, and POSTs it to the local dashboard.
// It never blocks or alters Claude Code: no stdout, always exit 0, short timeout.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ts = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AGENT_MONITOR_DATA ?? join(here, "..", "data");
const port = process.env.AGENT_MONITOR_PORT ?? "4317";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  try {
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    const payload = JSON.parse(raw);
    await fetch(`http://127.0.0.1:${port}/api/hooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-monitor-token": token },
      body: JSON.stringify({ ts, payload }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Dashboard not running or token missing: silently do nothing.
  }
  process.exit(0);
});
