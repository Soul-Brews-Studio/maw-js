/**
 * Threads API — persistent message channels between Oracles.
 *
 * Backs `maw talk-to <target>` (see src/commands/plugins/talk-to/impl.ts).
 * Channel threads use the convention `title === "channel:<target>"`.
 *
 * Storage: SQLite at ~/.maw/threads.db (override with MAW_THREADS_DB env var
 * for tests). DB and schema are created lazily on first request.
 *
 * Contracts (load-bearing — talk-to plugin will not change):
 *   GET  /api/threads?limit&status   → { threads: [{id,title,status,created_at}] }
 *   POST /api/thread                 → create-or-append
 *     { message, role?, title }              creates thread + first message
 *     { message, role?, thread_id }          appends to existing thread
 *     → { thread_id, message_id, status:"ok", oracle_response: null }
 *   GET  /api/thread/:id             → { thread, messages: [...] }
 */

import { Elysia, t } from "elysia";
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

let _db: Database | null = null;
let _dbPath: string | null = null;

function dbPath(): string {
  return process.env.MAW_THREADS_DB || join(homedir(), ".maw", "threads.db");
}

function getDb(): Database {
  const path = dbPath();
  if (_db && _dbPath === path) return _db;
  if (_db) { try { _db.close(); } catch { /* noop */ } }
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_title ON threads(title);`);
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON thread_messages(thread_id);`);
  _db = db;
  _dbPath = path;
  return db;
}

// SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC). Reshape to ISO-8601.
function isoFromSqlite(s: string): string {
  if (/T.*Z$/.test(s)) return s;
  return s.replace(" ", "T") + "Z";
}

interface ThreadRow {
  id: number;
  title: string;
  status: string;
  created_at: string;
}

interface MessageRow {
  id: number;
  thread_id: number;
  role: string;
  content: string;
  created_at: string;
}

function shapeThread(row: ThreadRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: isoFromSqlite(row.created_at),
  };
}

function shapeMessage(row: MessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: isoFromSqlite(row.created_at),
  };
}

export const threadsApi = new Elysia()
  .get("/threads", ({ query }) => {
    const db = getDb();
    const limit = Math.min(500, Math.max(1, parseInt(query?.limit ?? "50", 10) || 50));
    const status = query?.status;
    const rows = (status
      ? db.query(`SELECT id, title, status, created_at FROM threads WHERE status = ? ORDER BY id DESC LIMIT ?`).all(status, limit)
      : db.query(`SELECT id, title, status, created_at FROM threads ORDER BY id DESC LIMIT ?`).all(limit)
    ) as ThreadRow[];
    return { threads: rows.map(shapeThread) };
  }, {
    query: t.Object({
      limit: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }),
  })
  .post("/thread", ({ body, set }) => {
    const db = getDb();
    const message = body.message;
    const role = body.role ?? "claude";
    const threadId = body.thread_id;
    const title = body.title;

    if (!threadId && !title) {
      set.status = 400;
      return { error: "thread_id or title required" };
    }
    if (threadId && title) {
      set.status = 400;
      return { error: "supply thread_id OR title, not both" };
    }

    if (threadId) {
      const thread = db.query(`SELECT id, status FROM threads WHERE id = ?`).get(threadId) as
        | { id: number; status: string }
        | null;
      if (!thread || thread.status === "closed") {
        set.status = 409;
        return { error: "thread not found or closed" };
      }
      const insert = db
        .query(`INSERT INTO thread_messages (thread_id, role, content) VALUES (?, ?, ?) RETURNING id`)
        .get(threadId, role, message) as { id: number };
      return {
        thread_id: threadId,
        message_id: insert.id,
        status: "ok",
        oracle_response: null,
      };
    }

    const tx = db.transaction((tt: string, rr: string, mm: string) => {
      const thread = db
        .query(`INSERT INTO threads (title) VALUES (?) RETURNING id`)
        .get(tt) as { id: number };
      const msg = db
        .query(`INSERT INTO thread_messages (thread_id, role, content) VALUES (?, ?, ?) RETURNING id`)
        .get(thread.id, rr, mm) as { id: number };
      return { thread_id: thread.id, message_id: msg.id };
    });
    const created = tx(title!, role, message);
    return {
      thread_id: created.thread_id,
      message_id: created.message_id,
      status: "ok",
      oracle_response: null,
    };
  }, {
    body: t.Object({
      message: t.String({ minLength: 1 }),
      role: t.Optional(t.String()),
      thread_id: t.Optional(t.Number()),
      title: t.Optional(t.String({ minLength: 1 })),
    }),
  })
  .get("/thread/:id", ({ params, set }) => {
    const db = getDb();
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) {
      set.status = 400;
      return { error: "invalid id" };
    }
    const thread = db
      .query(`SELECT id, title, status, created_at FROM threads WHERE id = ?`)
      .get(id) as ThreadRow | null;
    if (!thread) {
      set.status = 404;
      return { error: "thread not found" };
    }
    const messages = db
      .query(`SELECT id, thread_id, role, content, created_at FROM thread_messages WHERE thread_id = ? ORDER BY id ASC`)
      .all(id) as MessageRow[];
    return {
      thread: shapeThread(thread),
      messages: messages.map(shapeMessage),
    };
  });
