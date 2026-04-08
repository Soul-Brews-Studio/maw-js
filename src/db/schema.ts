/**
 * MAW Dashboard Pro — SQLite Schema (Drizzle ORM)
 *
 * Secondary persistence layer for historical queries.
 * Filesystem remains primary for real-time state.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Feed events — durable history of all oracle activity.
 * In-memory buffer is ephemeral (500 events); this table keeps everything.
 */
export const feedEvents = sqliteTable("feed_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull(),          // ISO 8601 from feed line
  ts: integer("ts").notNull(),                      // epoch ms for fast range queries
  oracle: text("oracle").notNull(),
  host: text("host").notNull(),
  event: text("event").notNull(),                   // FeedEventType
  project: text("project").notNull(),
  sessionId: text("session_id").notNull(),
  message: text("message").notNull(),
});

/**
 * Audit log — durable version of audit.jsonl.
 * Tracks CLI commands, lifecycle events, crashes.
 */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),                      // epoch ms
  timestamp: text("timestamp").notNull(),           // ISO 8601
  cmd: text("cmd"),                                 // CLI command (wake, sleep, done, etc.)
  args: text("args"),                               // JSON-stringified args array
  oracle: text("oracle"),                           // oracle name
  session: text("session"),                         // tmux session name
  event: text("event"),                             // event type if from feed
  status: text("status"),                           // status if applicable
  user: text("user"),                               // who triggered
});

/**
 * Snapshots — metadata index for fleet snapshots.
 * Full snapshot JSON stays on disk; this enables fast queries.
 */
export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull(),           // ISO 8601
  ts: integer("ts").notNull(),                      // epoch ms
  trigger: text("trigger").notNull(),               // wake/sleep/done/auto/manual
  node: text("node"),                               // machine identity
  sessionCount: integer("session_count").notNull(),
  windowCount: integer("window_count").notNull(),
  filename: text("filename").notNull(),             // pointer to JSON file on disk
});

/**
 * Server health snapshots — VPS metrics over time.
 * Collected by Pulse heartbeat every 5 minutes.
 */
export const healthSnapshots = sqliteTable("health_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),                          // epoch ms
  timestamp: text("timestamp").notNull(),               // ISO 8601
  memAvailMb: integer("mem_avail_mb").notNull(),        // available memory in MB
  memTotalMb: integer("mem_total_mb").notNull(),        // total memory in MB
  memUsedPct: integer("mem_used_pct").notNull(),        // % used
  diskUsedPct: integer("disk_used_pct").notNull(),      // % disk used on /
  diskAvailGb: integer("disk_avail_gb").notNull(),      // GB available
  loadAvg: text("load_avg").notNull(),                  // "0.96 0.62 0.32"
  cpuCount: integer("cpu_count").notNull(),             // number of CPUs
  pm2Online: integer("pm2_online").notNull(),           // PM2 processes online
  pm2Total: integer("pm2_total").notNull(),             // PM2 processes total
  dockerRunning: integer("docker_running").notNull(),   // Docker containers running
  dockerTotal: integer("docker_total").notNull(),       // Docker containers total
  alertFired: integer("alert_fired").notNull().default(0), // 1 if alert was triggered
  alertReason: text("alert_reason"),                    // why alert fired
});

/**
 * Trials — SaaS onboarding sign-ups.
 */
export const trials = sqliteTable("trials", {
  id: text("id").primaryKey(),                       // UUID
  email: text("email").notNull().unique(),
  tier: text("tier").notNull().default("solo"),       // solo, team, fleet
  status: text("status").notNull().default("active"), // active, expired, cancelled
  createdAt: integer("created_at").notNull(),         // epoch ms
  expiresAt: integer("expires_at").notNull(),         // epoch ms
});

/**
 * Oracle health — latest known state per oracle.
 * Updated on every relevant feed event or audit entry.
 */
export const oracleHealth = sqliteTable("oracle_health", {
  oracle: text("oracle").primaryKey(),
  host: text("host"),
  lastSeen: integer("last_seen").notNull(),         // epoch ms
  lastEvent: text("last_event"),                    // last FeedEventType
  lastProject: text("last_project"),
  lastSessionId: text("last_session_id"),
  totalEvents: integer("total_events").notNull().default(0),
  totalSessions: integer("total_sessions").notNull().default(0),
  crashes: integer("crashes").notNull().default(0),
  lastCrash: integer("last_crash"),                 // epoch ms, nullable
  updatedAt: integer("updated_at").notNull(),       // epoch ms
});
