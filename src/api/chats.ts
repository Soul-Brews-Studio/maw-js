/**
 * Chats API — persistent OracleNet message history.
 *
 * SQLite-backed chat persistence via Drizzle ORM.
 * Replaces jsonl-only storage with queryable, paginated history.
 */

import { Hono } from "hono";
import { eq, desc, and, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { chats } from "../db/schema";
import { mawLogListeners } from "./maw-log";

export const chatsApi = new Hono();

/** GET /chats — paginated chat history */
chatsApi.get("/chats", (c) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 1000);
    const offset = parseInt(c.req.query("offset") || "0", 10);
    const from = c.req.query("from");
    const to = c.req.query("to");
    const threadId = c.req.query("threadId");

    const conditions = [eq(chats.archived, 0)];
    if (from) conditions.push(eq(chats.from, from));
    if (to) conditions.push(eq(chats.to, to));
    if (threadId) conditions.push(eq(chats.threadId, threadId));

    const entries = db
      .select()
      .from(chats)
      .where(and(...conditions))
      .orderBy(desc(chats.ts))
      .limit(limit)
      .offset(offset)
      .all()
      .reverse(); // return chronological order (oldest first)

    const [{ total }] = db
      .select({ total: sql<number>`count(*)` })
      .from(chats)
      .where(and(...conditions))
      .all();

    return c.json({ entries, total, limit, offset });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** POST /chats — save new message to DB + broadcast via WebSocket */
chatsApi.post("/chats", async (c) => {
  try {
    const body = await c.req.json<{
      from: string;
      to: string;
      msg: string;
      threadId?: string;
    }>();

    if (!body.from || !body.to || !body.msg) {
      return c.json({ error: "from, to, msg required" }, 400);
    }

    const db = getDb();
    const ts = new Date().toISOString();

    const [entry] = db
      .insert(chats)
      .values({
        from: body.from,
        to: body.to,
        msg: body.msg,
        ts,
        threadId: body.threadId || null,
      })
      .returning()
      .all();

    // Broadcast to all connected WebSocket clients
    for (const fn of mawLogListeners) {
      fn({ ts, from: body.from, to: body.to, msg: body.msg });
    }

    return c.json({ ok: true, entry });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
