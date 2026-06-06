import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { mawConfigPath, mawDataPath, type MessageDirection, type MessageLifecycleData, type MessageState } from "@maw-js/sdk";
import { resolveMessageRetentionPolicy, type RetentionPolicy } from "./retention";

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

export interface MessageLedgerRetentionPolicy {
  maxMessages?: number;
}

export interface MessageLedgerRetentionSummary {
  retained: number;
  removed: number;
  policy: { keepLast: number; maxAgeDays: number };
}

export const DEFAULT_MAX_MESSAGES = 50_000;

export function messageLedgerDbPath(): string {
  return mawDataPath("message-ledger.sqlite");
}

function legacyMessageLedgerDbPath(): string {
  return mawConfigPath("message-ledger.sqlite");
}

function prepareDbPath(): string {
  const file = messageLedgerDbPath();
  if (!existsSync(file)) {
    const legacy = legacyMessageLedgerDbPath();
    if (existsSync(legacy)) { mkdirSync(dirname(file), { recursive: true }); copyFileSync(legacy, file); }
  }
  return file;
}

function openDb(): Database {
  const file = prepareDbPath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ts TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, channel TEXT NOT NULL, route TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, target TEXT, peer_url TEXT, text TEXT NOT NULL, error TEXT, last_line TEXT, signed INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts); CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id); CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id); CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction); CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);");
  return db;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function resolveMessageLedgerRetentionPolicy(policy: MessageLedgerRetentionPolicy = {}): { maxMessages: number } {
  return {
    maxMessages: positiveInt(policy.maxMessages)
      ?? positiveInt(process.env.MAW_MESSAGE_LEDGER_MAX_MESSAGES)
      ?? DEFAULT_MAX_MESSAGES,
  };
}

function messageCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM messages").get() as { count?: number | bigint } | null;
  return Number(row?.count ?? 0);
}

function pruneMessageLedgerDb(db: Database, policy: MessageLedgerRetentionPolicy = {}): number {
  const { maxMessages } = resolveMessageLedgerRetentionPolicy(policy);
  const before = messageCount(db);
  if (before <= maxMessages) return 0;
  db.query("DELETE FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages ORDER BY ts DESC, rowid DESC LIMIT $limit)").run({
    $limit: maxMessages,
  });
  return before - messageCount(db);
}

export function pruneMessageLedger(policy: MessageLedgerRetentionPolicy = {}): number {
  const db = openDb();
  try {
    return pruneMessageLedgerDb(db, policy);
  } finally {
    db.close();
  }
}

export function recordMessageLedgerEvent(event: MessageLifecycleData): void {
  const db = openDb();
  try {
    db.query("INSERT OR REPLACE INTO messages (id, ts, direction, state, channel, route, from_id, to_id, target, peer_url, text, error, last_line, signed) VALUES ($id, $ts, $direction, $state, $channel, $route, $from, $to, $target, $peerUrl, $text, $error, $lastLine, $signed)").run({
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
    pruneMessageLedgerEvents({}, db);

  } finally {
    db.close();
  }
}

export function pruneMessageLedgerEvents(policy: RetentionPolicy = {}, dbOverride?: Database): MessageLedgerRetentionSummary {
  const db = dbOverride ?? openDb();
  try {
    const resolved = resolveMessageRetentionPolicy(policy);
    const now = policy.now ?? new Date();
    const cutoff = new Date(now.getTime() - resolved.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const before = Number((db.query("SELECT COUNT(*) AS count FROM messages").get() as any)?.count || 0);
    db.query("DELETE FROM messages WHERE ts < $cutoff AND id NOT IN (SELECT id FROM messages ORDER BY ts DESC LIMIT $keepLast)").run({ $cutoff: cutoff, $keepLast: resolved.keepLast });
    db.query("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY ts DESC LIMIT $keepLast)").run({ $keepLast: resolved.keepLast });
    const retained = Number((db.query("SELECT COUNT(*) AS count FROM messages").get() as any)?.count || 0);
    return { retained, removed: Math.max(0, before - retained), policy: resolved };
  } finally {
    if (!dbOverride) db.close();
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
    const sql = `SELECT id, ts, direction, state, channel, route, from_id, to_id, target, peer_url, text, error, last_line, signed FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT $limit`;
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
