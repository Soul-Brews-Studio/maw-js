import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../paths";
import { listSnapshots, loadSnapshot, latestSnapshot } from "../snapshot";
import { getDb } from "../db";
import { oracleHealth, auditLog } from "../db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const monitoringApi = new Hono();

const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

/** Health overview — from SQLite oracleHealth table (fallback: audit.jsonl) */
monitoringApi.get("/monitoring/health", (c) => {
  try {
    let filteredOracles: any[];

    try {
      const db = getDb();
      const rows = db.select().from(oracleHealth).all();
      const SKIP_NAMES = new Set(["system", "all", "ls", "--help", "status", "unknown"]);
      filteredOracles = rows
        .filter(r => !SKIP_NAMES.has(r.oracle))
        .map(r => ({
          name: r.oracle,
          lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : "",
          totalSessions: r.totalSessions,
          crashes: r.crashes,
          lastCrash: r.lastCrash ? new Date(r.lastCrash).toISOString() : null,
          events: r.totalEvents,
          lastEvent: r.lastEvent,
          host: r.host,
        }));
    } catch {
      // DB not ready — fallback to audit.jsonl
      filteredOracles = healthFromAuditLog();
    }

    const latest = latestSnapshot();

    return c.json({
      oracles: filteredOracles,
      latestSnapshot: latest ? {
        timestamp: latest.timestamp,
        trigger: latest.trigger,
        sessions: latest.sessions.length,
      } : null,
    });
  } catch (e: any) {
    return c.json({ oracles: [], error: e.message });
  }
});

/** Audit log — paginated, from SQLite (fallback: audit.jsonl) */
monitoringApi.get("/monitoring/audit", (c) => {
  try {
    const oracle = c.req.query("oracle");
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    // Try SQLite first, fallback to audit.jsonl if DB empty or not ready
    let dbEntries: any[] | null = null;
    let dbTotal = 0;
    try {
      const db = getDb();
      const countResult = oracle
        ? db.select({ count: sql<number>`count(*)` }).from(auditLog).where(eq(auditLog.oracle, oracle)).get()
        : db.select({ count: sql<number>`count(*)` }).from(auditLog).get();
      dbTotal = countResult?.count ?? 0;

      if (dbTotal > 0) {
        let query = db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(limit).offset(offset);
        if (oracle) {
          query = db.select().from(auditLog).where(eq(auditLog.oracle, oracle)).orderBy(desc(auditLog.ts)).limit(limit).offset(offset);
        }
        dbEntries = query.all().map(r => ({
          ...r,
          args: r.args ? JSON.parse(r.args) : [],
        }));
      }
    } catch {}

    if (dbEntries && dbEntries.length > 0) {
      return c.json({ entries: dbEntries, total: dbTotal, limit, offset });
    }

    // Fallback to audit.jsonl
    let entries = readAuditLog(500);
    if (oracle) {
      entries = entries.filter(e =>
        e.oracle === oracle || e.session === oracle || e.name === oracle
      );
    }
    const total = entries.length;
    const page = entries.slice(offset, offset + limit);
    return c.json({ entries: page, total, limit, offset });
  } catch (e: any) {
    return c.json({ entries: [], total: 0, error: e.message });
  }
});

/** Snapshots list */
monitoringApi.get("/snapshots", (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const snapshots = listSnapshots().slice(0, limit);
    return c.json({ snapshots });
  } catch (e: any) {
    return c.json({ snapshots: [], error: e.message });
  }
});

/** Get specific snapshot */
monitoringApi.get("/snapshots/:id", (c) => {
  try {
    const snapshot = loadSnapshot(c.req.param("id"));
    if (!snapshot) return c.json({ error: "Snapshot not found" }, 404);
    return c.json({ snapshot });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** Fallback: build health from audit.jsonl when DB not available */
function healthFromAuditLog(): any[] {
  const entries = readAuditLog(200);
  const oracles = new Map<string, any>();
  for (const entry of entries) {
    const name = entry.oracle || entry.session
      || (entry.args?.[1] && !entry.args[1].startsWith("-") ? entry.args[1] : null)
      || "system";
    const timestamp = entry.timestamp || entry.ts || "";
    if (!oracles.has(name)) {
      oracles.set(name, { name, lastSeen: timestamp, totalSessions: 0, crashes: 0, lastCrash: null, events: 0 });
    }
    const o = oracles.get(name)!;
    o.events++;
    if (timestamp > o.lastSeen) o.lastSeen = timestamp;
    if (entry.event === "SessionStart" || entry.cmd === "wake") o.totalSessions++;
    if (entry.event === "Error" || entry.cmd === "crash" || entry.status === "crashed") {
      o.crashes++;
      if (!o.lastCrash || timestamp > o.lastCrash) o.lastCrash = timestamp;
    }
  }
  const SKIP_NAMES = new Set(["system", "all", "ls", "--help", "status"]);
  return Array.from(oracles.values()).filter(o => !SKIP_NAMES.has(o.name));
}

/** Read audit log — returns newest first */
function readAuditLog(maxLines: number): any[] {
  if (!existsSync(AUDIT_FILE)) return [];
  try {
    const content = readFileSync(AUDIT_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-maxLines)
      .reverse()
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
