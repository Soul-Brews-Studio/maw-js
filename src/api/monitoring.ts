import { Hono } from "hono";
import { listSnapshots, loadSnapshot, latestSnapshot } from "../snapshot";
import { getDb } from "../db";
import { oracleHealth, auditLog } from "../db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const monitoringApi = new Hono();

/** Health overview — from SQLite oracleHealth table */
monitoringApi.get("/monitoring/health", (c) => {
  try {
    const db = getDb();
    const rows = db.select().from(oracleHealth).all();
    const SKIP_NAMES = new Set(["system", "all", "ls", "--help", "status", "unknown"]);
    const filteredOracles = rows
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

/** Audit log — paginated, from SQLite */
monitoringApi.get("/monitoring/audit", (c) => {
  try {
    const db = getDb();
    const oracle = c.req.query("oracle");
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const countResult = oracle
      ? db.select({ count: sql<number>`count(*)` }).from(auditLog).where(eq(auditLog.oracle, oracle)).get()
      : db.select({ count: sql<number>`count(*)` }).from(auditLog).get();
    const total = countResult?.count ?? 0;

    let query = db.select().from(auditLog).orderBy(desc(auditLog.ts)).limit(limit).offset(offset);
    if (oracle) {
      query = db.select().from(auditLog).where(eq(auditLog.oracle, oracle)).orderBy(desc(auditLog.ts)).limit(limit).offset(offset);
    }
    const entries = query.all().map(r => ({
      ...r,
      action: r.cmd,       // frontend expects "action" for display
      args: r.args ? JSON.parse(r.args) : [],
    }));

    return c.json({ entries, total, limit, offset });
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

