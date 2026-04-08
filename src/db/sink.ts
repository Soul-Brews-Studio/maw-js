/**
 * MAW DB Sink — connects feed + audit streams to SQLite.
 *
 * Call attachSink() after initDb() to start persisting events.
 * Batches inserts for performance (flushes every 2s or 50 events).
 */

import { getDb } from "./index";
import { feedEvents, auditLog, oracleHealth } from "./schema";
import { sql } from "drizzle-orm";
import type { FeedEvent } from "../lib/feed";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { mawLogListeners } from "../api/maw-log";

const FLUSH_INTERVAL = 2000;
const FLUSH_BATCH_SIZE = 50;

let feedQueue: FeedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Flush queued feed events to SQLite */
function flushFeedQueue() {
  if (feedQueue.length === 0) return;

  const batch = feedQueue.splice(0);
  const db = getDb();

  try {
    db.insert(feedEvents)
      .values(
        batch.map((e) => ({
          timestamp: e.timestamp,
          ts: e.ts,
          oracle: e.oracle,
          host: e.host,
          event: e.event,
          project: e.project,
          sessionId: e.sessionId,
          message: e.message,
        })),
      )
      .run();

    // Update oracle_health for each unique oracle in this batch
    const seen = new Map<string, FeedEvent>();
    for (const e of batch) {
      const prev = seen.get(e.oracle);
      if (!prev || e.ts > prev.ts) seen.set(e.oracle, e);
    }

    for (const [oracle, e] of seen) {
      const isSession = e.event === "SessionStart";
      const isCrash = e.event === "Stop" && e.message.includes("crash");

      db.insert(oracleHealth)
        .values({
          oracle,
          host: e.host,
          lastSeen: e.ts,
          lastEvent: e.event,
          lastProject: e.project,
          lastSessionId: e.sessionId,
          totalEvents: 1,
          totalSessions: isSession ? 1 : 0,
          crashes: isCrash ? 1 : 0,
          lastCrash: isCrash ? e.ts : null,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: oracleHealth.oracle,
          set: {
            host: sql`excluded.host`,
            lastSeen: sql`excluded.last_seen`,
            lastEvent: sql`excluded.last_event`,
            lastProject: sql`excluded.last_project`,
            lastSessionId: sql`excluded.last_session_id`,
            totalEvents: sql`oracle_health.total_events + 1`,
            totalSessions: isSession
              ? sql`oracle_health.total_sessions + 1`
              : sql`oracle_health.total_sessions`,
            crashes: isCrash
              ? sql`oracle_health.crashes + 1`
              : sql`oracle_health.crashes`,
            lastCrash: isCrash
              ? sql`excluded.last_crash`
              : sql`oracle_health.last_crash`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }
  } catch (e) {
    console.error("[db:sink] feed flush error:", e);
  }
}

/** Write a single audit entry to SQLite */
export function sinkAuditEntry(entry: Record<string, any>) {
  try {
    const db = getDb();
    const now = Date.now();
    db.insert(auditLog)
      .values({
        ts: entry.ts ? new Date(entry.ts).getTime() : now,
        timestamp: entry.timestamp || entry.ts || new Date().toISOString(),
        cmd: entry.cmd || null,
        args: entry.args ? JSON.stringify(entry.args) : null,
        oracle: entry.oracle || entry.name || null,
        session: entry.session || null,
        event: entry.event || null,
        status: entry.status || null,
        user: entry.user || null,
      })
      .run();
  } catch (e) {
    console.error("[db:sink] audit write error:", e);
  }
}

/**
 * Chat sink — detect inter-oracle messages in feed events
 * and auto-write them to maw-log.jsonl for ChatView.
 *
 * Captures:
 * - UserPromptSubmit with "💬 from" or "💬 channel:" prefix (maw hey/talk-to delivery)
 * - Notification events with message content (direct notifications)
 */
const MAW_LOG_DIR = join(homedir(), ".oracle");
const MAW_LOG_FILE = join(MAW_LOG_DIR, "maw-log.jsonl");
const chatSeen = new Set<string>(); // dedup key: ts|from|to

function sinkChatFromFeed(event: FeedEvent) {
  // Pattern 1: UserPromptSubmit with "💬 from <oracle>" — this is a hey delivery
  const heyMatch = event.message.match(/^💬 from (\S+)/);
  if (event.event === "UserPromptSubmit" && heyMatch) {
    const from = heyMatch[1];
    const to = event.oracle;
    // Extract the actual message (after "from <name>\n" or quotes)
    const lines = event.message.split("\n");
    const msg = lines.length > 1
      ? lines.slice(1).map(l => l.replace(/^["']|["']$/g, "")).join("\n").trim()
      : event.message;
    writeChatEntry(event.timestamp, from, to, msg);
    return;
  }

  // Pattern 2: UserPromptSubmit with "💬 channel:" — talk-to delivery
  const channelMatch = event.message.match(/^💬 channel:(\S+)/);
  if (event.event === "UserPromptSubmit" && channelMatch) {
    const lines = event.message.split("\n");
    const fromLine = lines.find(l => l.startsWith("From: "));
    const previewLine = lines.find(l => l.startsWith("Preview: "));
    if (fromLine && previewLine) {
      const from = fromLine.replace("From: ", "").trim();
      const to = event.oracle;
      const msg = previewLine.replace("Preview: ", "").replace(/^["']|["']$/g, "").trim();
      writeChatEntry(event.timestamp, from, to, msg);
    }
    return;
  }

  // Pattern 3: Notification events between oracles
  if (event.event === "Notification" && event.message && event.oracle) {
    // Skip system notifications
    if (event.message.startsWith("[") || event.message.length < 5) return;
    // Can't determine sender from notification alone, skip unless structured
    return;
  }
}

function writeChatEntry(ts: string, from: string, to: string, msg: string) {
  if (!from || !to || !msg) return;

  // Normalize oracle names
  const normFrom = from.includes("-oracle") ? from : from + "-oracle";
  const normTo = to.includes("-oracle") ? to : to + "-oracle";

  // Dedup
  const key = `${ts}|${normFrom}|${normTo}`;
  if (chatSeen.has(key)) return;
  chatSeen.add(key);
  // Keep dedup set bounded
  if (chatSeen.size > 1000) {
    const entries = [...chatSeen];
    entries.splice(0, 500);
    chatSeen.clear();
    entries.forEach(e => chatSeen.add(e));
  }

  try {
    mkdirSync(MAW_LOG_DIR, { recursive: true });
    const entry = { ts, from: normFrom, to: normTo, msg, host: hostname() };
    appendFileSync(MAW_LOG_FILE, JSON.stringify(entry) + "\n");
    // Broadcast to WebSocket clients for real-time ChatView
    for (const fn of mawLogListeners) fn(entry);
    console.log(`[db:sink] chat: ${normFrom} → ${normTo}`);
  } catch (e) {
    console.error("[db:sink] chat write error:", e);
  }
}

/**
 * Attach the DB sink to the feed listener set.
 * Call once after initDb().
 */
export function attachSink(feedListeners: Set<(event: FeedEvent) => void>) {
  // Subscribe to feed events
  const listener = (event: FeedEvent) => {
    feedQueue.push(event);
    if (feedQueue.length >= FLUSH_BATCH_SIZE) flushFeedQueue();

    // Also check for chat messages in feed events
    sinkChatFromFeed(event);
  };
  feedListeners.add(listener);

  // Periodic flush for low-traffic periods
  flushTimer = setInterval(flushFeedQueue, FLUSH_INTERVAL);

  console.log("[db:sink] attached to feed listeners (+ chat sink)");

  return () => {
    feedListeners.delete(listener);
    if (flushTimer) clearInterval(flushTimer);
    flushFeedQueue(); // final flush
  };
}
