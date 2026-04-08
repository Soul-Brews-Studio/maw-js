/**
 * Onboarding API — SaaS trial sign-ups.
 */

import { Hono } from "hono";
import { getDb } from "../db";
import { trials } from "../db/schema";
import { eq } from "drizzle-orm";

export const onboardingApi = new Hono();

const TRIAL_DAYS = 14;

/** POST /onboarding/signup — create trial from email */
onboardingApi.post("/onboarding/signup", async (c) => {
  try {
    const { email, tier } = await c.req.json<{ email: string; tier?: string }>();

    if (!email || !email.includes("@") || email.length < 5) {
      return c.json({ error: "Valid email required" }, 400);
    }

    const db = getDb();
    const normalized = email.trim().toLowerCase();

    // Check existing
    const existing = db.select().from(trials).where(eq(trials.email, normalized)).get();
    if (existing) {
      return c.json({
        ok: true,
        trial: existing,
        existing: true,
      });
    }

    const now = Date.now();
    const record = {
      id: crypto.randomUUID(),
      email: normalized,
      tier: tier || "solo",
      status: "active",
      createdAt: now,
      expiresAt: now + TRIAL_DAYS * 24 * 60 * 60 * 1000,
    };

    db.insert(trials).values(record).run();

    return c.json({ ok: true, trial: record, existing: false });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** GET /onboarding/status/:id — check trial status */
onboardingApi.get("/onboarding/status/:id", (c) => {
  try {
    const db = getDb();
    const trial = db.select().from(trials).where(eq(trials.id, c.req.param("id"))).get();
    if (!trial) return c.json({ error: "Trial not found" }, 404);

    const expired = Date.now() > trial.expiresAt;
    return c.json({
      ...trial,
      status: expired ? "expired" : trial.status,
      daysLeft: expired ? 0 : Math.ceil((trial.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
