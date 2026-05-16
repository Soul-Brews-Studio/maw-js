import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { MessageDirection, MessageLifecycleData, MessageState } from "maw-js/lib/message-events";

export interface MessageLedgerQuery {
  limit?: number;
  from?: string;
  to?: string;
  direction?: MessageDirection;
  state?: MessageState;
  q?: string;
}

export interface MessageLedgerRow extends MessageLifecycleData {
  peerUrl?: string;
  lastLine?: string;
  error?: string;
  signed?: boolean;
}

function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function messageLedgerDbPath(): string {
  return join(activeConfigDir(), "message-ledger.sqlite");
}

function openDb(): Database {
  const file = messageLedgerDbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      direction TEXT NOT NULL,
      state TEXT NOT NULL,
      channel TEXT NOT NULL,
      route TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      target TEXT,
      peer_url TEXT,
      text TEXT NOT NULL,
      error TEXT,
      last_line TEXT,
      signed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
    CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
    CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);
  `);
  return db;
}

export function recordMessageLedgerEvent(event: MessageLifecycleData): void {
  const db = openDb();
  try {
    db.query(`
      INSERT OR REPLACE INTO messages (
        id, ts, direction, state, channel, route, from_id, to_id, target, peer_url,
        text, error, last_line, signed
      ) VALUES (
        $id, $ts, $direction, $state, $channel, $route, $from, $to, $target, $peerUrl,
        $text, $error, $lastLine, $signed
      )
    `).run({
      $id: event.id,
      $ts: event.ts,
      $direction: event.direction,
      $state: event.state,
      $channel: event.channel,
      $route: event.route,
      $from: event.from,
      $to: event.to,
      $target: event.target ?? null,
      $peerUrl: event.peerUrl ?? null,
      $text: event.text,
      $error: event.error ?? null,
      $lastLine: event.lastLine ?? null,
      $signed: event.signed ? 1 : 0,
    });
  } finally {
    db.close();
  }
}

export function listMessageLedgerEvents(query: MessageLedgerQuery = {}): MessageLedgerRow[] {
  const db = openDb();
  try {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.from) { where.push("from_id LIKE $from"); params.$from = `%${query.from}%`; }
    if (query.to) { where.push("to_id LIKE $to"); params.$to = `%${query.to}%`; }
    if (query.direction) { where.push("direction = $direction"); params.$direction = query.direction; }
    if (query.state) { where.push("state = $state"); params.$state = query.state; }
    if (query.q) {
      where.push("(text LIKE $q OR error LIKE $q OR last_line LIKE $q OR target LIKE $q)");
      params.$q = `%${query.q}%`;
    }
    const limit = Math.max(1, Math.min(Number(query.limit || 100) || 100, 1000));
    params.$limit = limit;
    const sql = `
      SELECT id, ts, direction, state, channel, route, from_id, to_id, target, peer_url, text, error, last_line, signed
      FROM messages
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ts DESC
      LIMIT $limit
    `;
    return db.query(sql).all(params).map((row: any) => ({
      id: String(row.id),
      ts: String(row.ts),
      direction: row.direction as MessageDirection,
      state: row.state as MessageState,
      channel: row.channel,
      route: row.route,
      from: row.from_id,
      to: row.to_id,
      ...(row.target ? { target: row.target } : {}),
      ...(row.peer_url ? { peerUrl: row.peer_url } : {}),
      text: row.text,
      ...(row.error ? { error: row.error } : {}),
      ...(row.last_line ? { lastLine: row.last_line } : {}),
      signed: Boolean(row.signed),
    }));
  } finally {
    db.close();
  }
}
