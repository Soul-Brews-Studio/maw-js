/**
 * API Key Authentication Middleware.
 *
 * Validates `X-Api-Key` header against api_keys table.
 * Injects tenant context into Hono context for downstream use.
 * Tracks usage for metering.
 */

import type { MiddlewareHandler } from "hono";
import { getDb } from "../db";
import { apiKeys, usageLogs } from "../db/schema";
import { eq, and, gt } from "drizzle-orm";

// Rate limit tracking: key → { count, windowStart }
const rateLimits = new Map<string, { count: number; windowStart: number }>();

/** Clean up expired rate limit entries every 5 minutes */
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, val] of rateLimits) {
    if (val.windowStart < cutoff) rateLimits.delete(key);
  }
}, 300_000);

/**
 * Middleware that validates API key and injects tenant info.
 * Skips if no X-Api-Key header (falls through to other auth).
 */
export function apiKeyAuth(): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("x-api-key");
    if (!header) return next(); // no API key → skip, let other auth handle

    const db = getDb();
    const record = db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.key, header), eq(apiKeys.status, "active")))
      .get();

    if (!record) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }

    // Rate limiting
    const now = Date.now();
    let rl = rateLimits.get(record.id);
    if (!rl || now - rl.windowStart > 60_000) {
      rl = { count: 0, windowStart: now };
      rateLimits.set(record.id, rl);
    }
    rl.count++;

    if (rl.count > record.rateLimit) {
      return c.json(
        { error: "Rate limit exceeded", limit: record.rateLimit, retryAfter: Math.ceil((rl.windowStart + 60_000 - now) / 1000) },
        429,
      );
    }

    // Set tenant context
    c.set("apiKey" as never, record as never);
    c.set("tenantId" as never, record.trialId as never);

    // Update last used (async, don't block)
    db.update(apiKeys).set({ lastUsed: now }).where(eq(apiKeys.id, record.id)).run();

    const start = now;
    await next();

    // Log usage (async, don't block response)
    const method = c.req.method;
    const path = new URL(c.req.url).pathname.replace(/^\/api/, "");
    db.insert(usageLogs)
      .values({
        apiKeyId: record.id,
        endpoint: `${method} ${path}`,
        ts: now,
        responseMs: Date.now() - start,
        status: c.res.status,
      })
      .run();
  };
}
