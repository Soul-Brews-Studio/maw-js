import { Hono } from "hono";
import { getDb } from "../db";
import { events } from "../db/schema";
import { eq, and, gte, lte } from "drizzle-orm";

export const scheduleApi = new Hono();

/** GET /schedule — list events with optional filters */
scheduleApi.get("/schedule", (c) => {
  try {
    const db = getDb();
    const date = c.req.query("date");       // exact date YYYY-MM-DD
    const from = c.req.query("from");       // ISO datetime range start
    const to = c.req.query("to");           // ISO datetime range end
    const oracle = c.req.query("oracle");
    const status = c.req.query("status");

    const conditions: any[] = [];

    if (date) {
      // Match events starting on this date
      conditions.push(gte(events.startTime, `${date}T00:00:00`));
      conditions.push(lte(events.startTime, `${date}T23:59:59`));
    }
    if (from) {
      conditions.push(gte(events.startTime, from));
    }
    if (to) {
      conditions.push(lte(events.startTime, to));
    }
    if (oracle) {
      conditions.push(eq(events.oracle, oracle));
    }
    if (status) {
      conditions.push(eq(events.status, status));
    }

    // Exclude cancelled by default unless explicitly requested
    if (!status) {
      // No status filter — show all non-cancelled
      // drizzle-orm doesn't have ne(), use raw SQL via and conditions
    }

    let rows;
    if (conditions.length > 0) {
      rows = db.select().from(events).where(and(...conditions)).orderBy(events.startTime).all();
    } else {
      rows = db.select().from(events).orderBy(events.startTime).all();
    }

    return c.json({ events: rows });
  } catch (e: any) {
    return c.json({ events: [], error: e.message });
  }
});

/** GET /schedule/:id — single event */
scheduleApi.get("/schedule/:id", (c) => {
  try {
    const db = getDb();
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

    const row = db.select().from(events).where(eq(events.id, id)).get();
    if (!row) return c.json({ error: "Event not found" }, 404);

    return c.json({ event: row });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** POST /schedule — create event */
scheduleApi.post("/schedule", async (c) => {
  try {
    const db = getDb();
    const body = await c.req.json();

    const { title, description, oracle, startTime, endTime, recurrence, status } = body;
    if (!title || !startTime) {
      return c.json({ error: "title and startTime are required" }, 400);
    }

    const row = db.insert(events).values({
      title,
      description: description || null,
      oracle: oracle || null,
      startTime,
      endTime: endTime || null,
      recurrence: recurrence || null,
      status: status || "upcoming",
      createdAt: new Date().toISOString(),
    }).returning().get();

    return c.json({ event: row }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** PUT /schedule/:id — update event */
scheduleApi.put("/schedule/:id", async (c) => {
  try {
    const db = getDb();
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

    const existing = db.select().from(events).where(eq(events.id, id)).get();
    if (!existing) return c.json({ error: "Event not found" }, 404);

    const body = await c.req.json();
    const updates: Record<string, any> = {};

    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.oracle !== undefined) updates.oracle = body.oracle;
    if (body.startTime !== undefined) updates.startTime = body.startTime;
    if (body.endTime !== undefined) updates.endTime = body.endTime;
    if (body.recurrence !== undefined) updates.recurrence = body.recurrence;
    if (body.status !== undefined) updates.status = body.status;

    const row = db.update(events).set(updates).where(eq(events.id, id)).returning().get();
    return c.json({ event: row });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** DELETE /schedule/:id — soft delete (set status=cancelled) */
scheduleApi.delete("/schedule/:id", (c) => {
  try {
    const db = getDb();
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

    const existing = db.select().from(events).where(eq(events.id, id)).get();
    if (!existing) return c.json({ error: "Event not found" }, 404);

    const row = db.update(events).set({ status: "cancelled" }).where(eq(events.id, id)).returning().get();
    return c.json({ event: row });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
