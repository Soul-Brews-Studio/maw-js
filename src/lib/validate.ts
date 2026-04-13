/**
 * Hono middleware for TypeBox request body validation.
 *
 * Usage:
 *   import { validateBody } from "../lib/validate";
 *   import { WakeBody } from "../lib/schemas";
 *   app.post("/wake", validateBody(WakeBody), async (c) => {
 *     const body = c.get("body") as TWakeBody;
 *     ...
 *   });
 *
 * When migrated to Elysia this middleware goes away — Elysia validates
 * natively via t.Object() in the route definition.
 */

import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { MiddlewareHandler } from "hono";

export function validateBody<T extends TSchema>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!Value.Check(schema, body)) {
      const errors = [...Value.Errors(schema, body)].map((e) => ({
        path: e.path,
        message: e.message,
      }));
      return c.json({ error: "validation failed", details: errors }, 400);
    }
    c.set("body", body);
    await next();
  };
}
