import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Entities are stored as JSON documents with a few indexed columns; events are
// an append-only log with a unique dedupe key so replays are ignored.
export function openDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, "agent-monitor.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS entities (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      session_id TEXT,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS entities_session ON entities(kind, session_id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      tool_name TEXT,
      tool_use_id TEXT,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      milestone INTEGER NOT NULL DEFAULT 0,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, ts);
    CREATE INDEX IF NOT EXISTS events_milestone ON events(milestone, ts);
    CREATE INDEX IF NOT EXISTS events_tool ON events(tool_use_id);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      outcome TEXT
    );
  `);
  return db;
}
