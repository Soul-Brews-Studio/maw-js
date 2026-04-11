/**
 * Tenant API — API key management + usage stats.
 *
 * Extends the onboarding/trials system with multi-tenant auth.
 */

import { Hono } from "hono";
import { getDb } from "../db";
import { apiKeys, usageLogs, trials } from "../db/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";

export const tenantApi = new Hono();

/** Generate a random API key: maw_<32 hex chars> */
function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `maw_${hex}`;
}

/** POST /tenant/keys — create API key for a trial */
tenantApi.post("/tenant/keys", async (c) => {
  const { trialId, name } = await c.req.json<{ trialId: string; name?: string }>();

  if (!trialId) return c.json({ error: "trialId required" }, 400);

  const db = getDb();
  const trial = db.select().from(trials).where(eq(trials.id, trialId)).get();
  if (!trial) return c.json({ error: "Trial not found" }, 404);
  if (trial.status !== "active" || Date.now() > trial.expiresAt) {
    return c.json({ error: "Trial expired or inactive" }, 403);
  }

  // Max 5 keys per trial
  const existing = db.select().from(apiKeys).where(eq(apiKeys.trialId, trialId)).all();
  if (existing.length >= 5) {
    return c.json({ error: "Max 5 API keys per trial" }, 400);
  }

  const tierLimits: Record<string, number> = { solo: 60, team: 300, fleet: 1000 };
  const record = {
    id: `ak_${crypto.randomUUID()}`,
    trialId,
    key: generateApiKey(),
    name: name || "default",
    tier: trial.tier,
    rateLimit: tierLimits[trial.tier] || 60,
    status: "active",
    createdAt: Date.now(),
  };

  db.insert(apiKeys).values(record).run();

  return c.json({ ok: true, apiKey: record }, 201);
});

/** GET /tenant/keys/:trialId — list API keys for a trial */
tenantApi.get("/tenant/keys/:trialId", (c) => {
  const db = getDb();
  const keys = db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPreview: sql<string>`substr(${apiKeys.key}, 1, 8) || '...'`,
      tier: apiKeys.tier,
      rateLimit: apiKeys.rateLimit,
      status: apiKeys.status,
      lastUsed: apiKeys.lastUsed,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.trialId, c.req.param("trialId")))
    .all();

  return c.json({ keys, total: keys.length });
});

/** DELETE /tenant/keys/:keyId — revoke an API key */
tenantApi.delete("/tenant/keys/:keyId", (c) => {
  const db = getDb();
  const result = db
    .update(apiKeys)
    .set({ status: "revoked" })
    .where(eq(apiKeys.id, c.req.param("keyId")))
    .run();

  if (result.changes === 0) return c.json({ error: "Key not found" }, 404);
  return c.json({ ok: true });
});

/** GET /tenant/usage/:trialId — usage stats for a tenant */
tenantApi.get("/tenant/usage/:trialId", (c) => {
  const db = getDb();
  const trialId = c.req.param("trialId");
  const hours = parseInt(c.req.query("hours") || "24");
  const since = Date.now() - hours * 60 * 60 * 1000;

  // Get all keys for this trial
  const keys = db.select().from(apiKeys).where(eq(apiKeys.trialId, trialId)).all();
  if (keys.length === 0) return c.json({ error: "No keys for this trial" }, 404);

  const keyIds = keys.map((k) => k.id);

  // Aggregate usage per endpoint
  const usage = db
    .select({
      endpoint: usageLogs.endpoint,
      count: sql<number>`count(*)`,
      avgMs: sql<number>`avg(${usageLogs.responseMs})`,
    })
    .from(usageLogs)
    .where(
      and(
        sql`${usageLogs.apiKeyId} IN (${sql.join(keyIds.map(id => sql`${id}`), sql`, `)})`,
        gte(usageLogs.ts, since),
      ),
    )
    .groupBy(usageLogs.endpoint)
    .all();

  // Total count
  const total = usage.reduce((sum, u) => sum + u.count, 0);

  return c.json({
    trialId,
    hours,
    totalRequests: total,
    endpoints: usage,
    keys: keys.length,
    tier: keys[0]?.tier,
  });
});
