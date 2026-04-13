/**
 * Avengers API proxy — bridges maw-js to ARRA-01/avengers rate limit monitor.
 *
 * Routes:
 *   GET /api/avengers/status    → all accounts with rate limit info
 *   GET /api/avengers/best      → account with most capacity
 *   GET /api/avengers/traffic   → traffic stats across accounts
 */

import { Hono } from "hono";
import type { MawConfig } from "../config";

export const avengersApi = new Hono();

/** Extract avengers base URL from injected config */
function getAvengersUrl(c: { get: (key: never) => unknown }): string | null {
  const config = c.get("config" as never) as MawConfig & { avengers?: string };
  return config.avengers || null;
}

// GET /api/avengers/status — all accounts with rate limit windows
avengersApi.get("/avengers/status", async (c) => {
  const base = getAvengersUrl(c);
  if (!base) return c.json({ error: "avengers not configured" }, 503);

  try {
    const res = await fetch(`${base}/all`, { signal: AbortSignal.timeout(5000) });
    const accounts = await res.json();
    return c.json({
      accounts,
      total: Array.isArray(accounts) ? accounts.length : 0,
      source: base,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return c.json({ error: `avengers unreachable: ${err.message}` }, 502);
  }
});

// GET /api/avengers/best — account with most remaining capacity
avengersApi.get("/avengers/best", async (c) => {
  const base = getAvengersUrl(c);
  if (!base) return c.json({ error: "avengers not configured" }, 503);

  try {
    const res = await fetch(`${base}/best`, { signal: AbortSignal.timeout(5000) });
    const best = await res.json();
    return c.json(best);
  } catch (err: any) {
    return c.json({ error: `avengers unreachable: ${err.message}` }, 502);
  }
});

// GET /api/avengers/traffic — traffic stats per account
avengersApi.get("/avengers/traffic", async (c) => {
  const base = getAvengersUrl(c);
  if (!base) return c.json({ error: "avengers not configured" }, 503);

  try {
    const [trafficRes, speedRes] = await Promise.all([
      fetch(`${base}/traffic-stats`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${base}/speed`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);

    const traffic = await trafficRes.json();
    const speed = speedRes ? await speedRes.json().catch(() => null) : null;

    return c.json({
      traffic,
      speed,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return c.json({ error: `avengers unreachable: ${err.message}` }, 502);
  }
});

// GET /api/avengers/health — quick health check
avengersApi.get("/avengers/health", async (c) => {
  const base = getAvengersUrl(c);
  if (!base) return c.json({ configured: false, reachable: false });

  try {
    const start = Date.now();
    const res = await fetch(`${base}/all`, { signal: AbortSignal.timeout(3000) });
    const latency = Date.now() - start;
    const accounts = await res.json();

    return c.json({
      configured: true,
      reachable: res.ok,
      latency,
      accounts: Array.isArray(accounts) ? accounts.length : 0,
      url: base,
    });
  } catch {
    return c.json({ configured: true, reachable: false, url: base });
  }
});
