/**
 * Dispatch API — command center for ChatView.
 *
 * Full talk-to flow from UI: find oracle, check status, send to tmux.
 */

import { Hono } from "hono";
import { listSessions, findWindow, sendKeys, getPaneCommand, capture } from "../ssh";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { mawLogListeners } from "./maw-log";
import { getDb } from "../db";
import { chats } from "../db/schema";

export const dispatchApi = new Hono();

const MAW_LOG_DIR = join(homedir(), ".oracle");
const MAW_LOG_FILE = join(MAW_LOG_DIR, "maw-log.jsonl");

type OracleStatus = "busy" | "ready" | "idle" | "offline";

async function getOracleStatus(name: string): Promise<{ status: OracleStatus; target: string | null }> {
  try {
    const sessions = await listSessions();
    const target = findWindow(sessions, name) || findWindow(sessions, name.replace(/-oracle$/, ""));
    if (!target) return { status: "offline", target: null };

    const cmd = await getPaneCommand(target).catch(() => "");
    if (/claude|codex/i.test(cmd)) return { status: "busy", target };
    if (/node|bun|bash|zsh/i.test(cmd)) return { status: "ready", target };
    return { status: "idle", target };
  } catch {
    return { status: "offline", target: null };
  }
}

/** GET /dispatch/status/:oracle — check oracle status */
dispatchApi.get("/dispatch/status/:oracle", async (c) => {
  const name = c.req.param("oracle");
  const { status, target } = await getOracleStatus(name);
  return c.json({ oracle: name, status, target });
});

/** POST /dispatch — send command to oracle */
dispatchApi.post("/dispatch", async (c) => {
  try {
    const { from, to, msg } = await c.req.json<{ from: string; to: string; msg: string }>();
    if (!from || !to || !msg) return c.json({ error: "from, to, msg required" }, 400);

    // Write to maw-log (jsonl — backwards compat)
    const entry = { ts: new Date().toISOString(), from, to, msg, host: hostname(), ch: "dispatch" };
    mkdirSync(MAW_LOG_DIR, { recursive: true });
    appendFileSync(MAW_LOG_FILE, JSON.stringify(entry) + "\n");

    // Persist to chats DB
    try {
      const db = getDb();
      db.insert(chats).values({ from, to, msg, ts: entry.ts }).run();
    } catch (e) {
      console.error("[dispatch] chats DB write failed:", e);
    }

    // Broadcast to WS
    for (const fn of mawLogListeners) fn(entry);

    // Find and dispatch to oracle
    const { status, target } = await getOracleStatus(to);
    if (!target) {
      return c.json({ ok: true, entry, dispatched: false, status, error: "Oracle not found in tmux" });
    }

    const notification = `💬 from ${from}: "${msg}"`;
    await sendKeys(target, notification);

    return c.json({ ok: true, entry, dispatched: true, status, target });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** GET /dispatch/capture/:oracle — capture recent output */
dispatchApi.get("/dispatch/capture/:oracle", async (c) => {
  try {
    const name = c.req.param("oracle");
    const sessions = await listSessions();
    const target = findWindow(sessions, name) || findWindow(sessions, name.replace(/-oracle$/, ""));
    if (!target) return c.json({ error: "Oracle not found" }, 404);

    const content = await capture(target).catch(() => "");
    const lines = content.split("\n").filter((l: string) => l.trim()).slice(-30);
    return c.json({ oracle: name, target, lines });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
