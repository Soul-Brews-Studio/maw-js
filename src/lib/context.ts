/**
 * Hono middleware — inject shared dependencies into request context.
 *
 * Phase 2 of Hono -> Elysia migration (#309).
 * Provides a DI layer so API handlers read config from c.get("config")
 * instead of importing loadConfig() directly.
 *
 * When we move to Elysia, this becomes Elysia's native `derive()`.
 */

import type { MiddlewareHandler } from "hono";
import { loadConfig, type MawConfig } from "../config";

// Lazy singleton — initialized once, reused across requests
let _config: MawConfig | null = null;

export function withContext(): MiddlewareHandler {
  return async (c, next) => {
    if (!_config) _config = loadConfig();
    c.set("config" as never, _config as never);
    await next();
  };
}

/** Refresh cached config (call after config file changes) */
export function refreshContext() {
  _config = null;
}
