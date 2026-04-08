/**
 * MAW Log API — OracleNet chat history.
 *
 * Reads from two sources:
 * 1. ~/.oracle/maw-log.jsonl (from `maw talk-to`)
 * 2. ~/.config/maw/audit.jsonl (from `maw hey` commands)
 *
 * Returns unified MawLogEntry[] for ChatView.
 */

import { Hono } from "hono";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { CONFIG_DIR } from "../paths";
import { listSessions, findWindow, sendKeys } from "../ssh";

export const mawLogApi = new Hono();

/** Listeners for real-time maw-log broadcast (engine subscribes to push via WS) */
export const mawLogListeners = new Set<(entry: MawLogEntry) => void>();

interface MawLogEntry {
  ts: string;
  from: string;
  to: string;
  msg: string;
  ch?: string;
}

const MAW_LOG_FILE = join(homedir(), ".oracle", "maw-log.jsonl");
const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

/** Read maw-log.jsonl entries (talk-to) */
function readMawLog(limit: number): MawLogEntry[] {
  if (!existsSync(MAW_LOG_FILE)) return [];
  try {
    const lines = readFileSync(MAW_LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          const d = JSON.parse(line);
          return { ts: d.ts, from: d.from, to: d.to, msg: d.msg, ch: d.ch } as MawLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is MawLogEntry => e !== null && !!e.from && !!e.to);
  } catch {
    return [];
  }
}

/** Extract chat entries from audit.jsonl hey commands */
function readAuditHey(limit: number): MawLogEntry[] {
  if (!existsSync(AUDIT_FILE)) return [];
  try {
    const lines = readFileSync(AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean);
    const entries: MawLogEntry[] = [];

    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.cmd !== "hey") continue;
        const args: string[] = d.args || [];
        // args = ["hey", target, message] or ["hey", target, message, "--force"]
        const target = args[1];
        const msg = args[2];
        if (!target || !msg) continue;
        // Skip technical messages (commands, flags)
        if (msg.startsWith("--") || msg.startsWith("claude ")) continue;

        const from = d.user === "root" ? "labubu-oracle" : (d.oracle || d.user || "system");
        entries.push({
          ts: d.ts,
          from,
          to: target.includes("-oracle") ? target : target + "-oracle",
          msg,
        });
      } catch {}
    }

    return entries.slice(-limit);
  } catch {
    return [];
  }
}

/** Merge and deduplicate entries from both sources, sort by timestamp */
function mergeEntries(limit: number): MawLogEntry[] {
  const mawEntries = readMawLog(limit);
  const auditEntries = readAuditHey(limit);

  // Deduplicate by ts+from+to (talk-to writes to both files)
  const seen = new Set<string>();
  const all: MawLogEntry[] = [];

  for (const e of [...mawEntries, ...auditEntries]) {
    const key = `${e.ts}|${e.from}|${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(e);
  }

  // Sort oldest first (ChatView expects chronological order)
  all.sort((a, b) => a.ts.localeCompare(b.ts));

  return all.slice(-limit);
}

/** GET /api/maw-log — paginated chat history */
mawLogApi.get("/maw-log", (c) => {
  const limit = parseInt(c.req.query("limit") || "500", 10);
  const oracle = c.req.query("oracle");

  let entries = mergeEntries(limit);

  if (oracle) {
    entries = entries.filter((e) => e.from === oracle || e.to === oracle);
  }

  return c.json({ entries, total: entries.length });
});

/** POST /api/maw-log — write a new chat entry (for UI send) */
mawLogApi.post("/maw-log", async (c) => {
  try {
    const body = await c.req.json<{ from: string; to: string; msg: string; ch?: string }>();
    if (!body.from || !body.to || !body.msg) {
      return c.json({ error: "from, to, msg required" }, 400);
    }

    const entry: MawLogEntry = {
      ts: new Date().toISOString(),
      from: body.from,
      to: body.to,
      msg: body.msg,
      ch: body.ch,
    };

    // Write to maw-log.jsonl
    const dir = join(homedir(), ".oracle");
    mkdirSync(dir, { recursive: true });
    appendFileSync(MAW_LOG_FILE, JSON.stringify({ ...entry, host: hostname() }) + "\n");

    // Broadcast to all connected WebSocket clients
    for (const fn of mawLogListeners) fn(entry);

    // Dispatch to Oracle tmux if target is an oracle agent
    let dispatched = false;
    if (body.from === "nat" || !body.from.includes("-oracle")) {
      try {
        const sessions = await listSessions();
        const target = findWindow(sessions, body.to) || findWindow(sessions, body.to.replace(/-oracle$/, ""));
        if (target) {
          const notification = `💬 from ${body.from}: "${body.msg}"`;
          await sendKeys(target, notification);
          dispatched = true;
        }
      } catch (e) {
        console.error("[maw-log] dispatch failed:", e);
      }
    }

    return c.json({ ok: true, entry, dispatched });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
