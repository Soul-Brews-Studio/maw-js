/**
 * MAW Database Migrations — auto-run on startup.
 *
 * Simple versioned migrations using a _migrations table.
 * Each migration runs once, tracked by version number.
 */

import type { Database } from "bun:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "create_feed_events",
    sql: `
      CREATE TABLE IF NOT EXISTS feed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        ts INTEGER NOT NULL,
        oracle TEXT NOT NULL,
        host TEXT NOT NULL,
        event TEXT NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feed_events_ts ON feed_events(ts);
      CREATE INDEX IF NOT EXISTS idx_feed_events_oracle ON feed_events(oracle);
      CREATE INDEX IF NOT EXISTS idx_feed_events_event ON feed_events(event);
    `,
  },
  {
    version: 2,
    name: "create_audit_log",
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        cmd TEXT,
        args TEXT,
        oracle TEXT,
        session TEXT,
        event TEXT,
        status TEXT,
        user TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_log_oracle ON audit_log(oracle);
    `,
  },
  {
    version: 3,
    name: "create_snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        ts INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        node TEXT,
        session_count INTEGER NOT NULL,
        window_count INTEGER NOT NULL,
        filename TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
    `,
  },
  {
    version: 4,
    name: "create_oracle_health",
    sql: `
      CREATE TABLE IF NOT EXISTS oracle_health (
        oracle TEXT PRIMARY KEY,
        host TEXT,
        last_seen INTEGER NOT NULL,
        last_event TEXT,
        last_project TEXT,
        last_session_id TEXT,
        total_events INTEGER NOT NULL DEFAULT 0,
        total_sessions INTEGER NOT NULL DEFAULT 0,
        crashes INTEGER NOT NULL DEFAULT 0,
        last_crash INTEGER,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

/**
 * Run all pending migrations. Idempotent — skips already-applied versions.
 */
export function migrate(db: Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.query("SELECT version FROM _migrations").all().map((r: any) => r.version),
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;

    db.exec("BEGIN");
    try {
      // Execute multi-statement SQL
      for (const stmt of m.sql.split(";").filter((s) => s.trim())) {
        db.exec(stmt + ";");
      }
      db.exec(
        `INSERT INTO _migrations (version, name) VALUES (${m.version}, '${m.name}')`,
      );
      db.exec("COMMIT");
      console.log(`[db] migration ${m.version}: ${m.name} ✓`);
    } catch (e) {
      db.exec("ROLLBACK");
      console.error(`[db] migration ${m.version} failed:`, e);
      throw e;
    }
  }
}
