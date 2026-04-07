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
 * Attach the DB sink to the feed listener set.
 * Call once after initDb().
 */
export function attachSink(feedListeners: Set<(event: FeedEvent) => void>) {
  // Subscribe to feed events
  const listener = (event: FeedEvent) => {
    feedQueue.push(event);
    if (feedQueue.length >= FLUSH_BATCH_SIZE) flushFeedQueue();
  };
  feedListeners.add(listener);

  // Periodic flush for low-traffic periods
  flushTimer = setInterval(flushFeedQueue, FLUSH_INTERVAL);

  console.log("[db:sink] attached to feed listeners");

  return () => {
    feedListeners.delete(listener);
    if (flushTimer) clearInterval(flushTimer);
    flushFeedQueue(); // final flush
  };
}
