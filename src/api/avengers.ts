/**
 * Avengers API proxy — bridges maw-js to ARRA-01/avengers rate limit monitor.
 *
 * Routes:
 *   GET /api/avengers/status    -> all accounts with rate limit info
 *   GET /api/avengers/best      -> account with most capacity
 *   GET /api/avengers/traffic   -> traffic stats across accounts
 */

import { Elysia} from "elysia";
import { loadConfig, type MawConfig } from "../config";

export const avengersApi = new Elysia();

/** Extract avengers base URL from config */
function getAvengersUrl(): string | null {
  const config = loadConfig() as MawConfig & { avengers?: string };
  return config.avengers || null;
}

// GET /api/avengers/status -- all accounts with rate limit windows
avengersApi.get("/avengers/status", async ({ set }) => {
  const base = getAvengersUrl();
  if (!base) { set.status = 503; return { error: "avengers not configured" }; }

  try {
    const res = await fetch(`${base}/all`, { signal: AbortSignal.timeout(5000) });
    const accounts = await res.json();
    return {
      accounts,
      total: Array.isArray(accounts) ? accounts.length : 0,
      source: base,
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    set.status = 502; return { error: `avengers unreachable: ${err.message}` };
  }
});

// GET /api/avengers/best -- account with most remaining capacity
avengersApi.get("/avengers/best", async ({ set }) => {
  const base = getAvengersUrl();
  if (!base) { set.status = 503; return { error: "avengers not configured" }; }

  try {
    const res = await fetch(`${base}/best`, { signal: AbortSignal.timeout(5000) });
    const best = await res.json();
    return best;
  } catch (err: any) {
    set.status = 502; return { error: `avengers unreachable: ${err.message}` };
  }
});

// GET /api/avengers/traffic -- traffic stats per account
avengersApi.get("/avengers/traffic", async ({ set }) => {
  const base = getAvengersUrl();
  if (!base) { set.status = 503; return { error: "avengers not configured" }; }

  try {
    const [trafficRes, speedRes] = await Promise.all([
      fetch(`${base}/traffic-stats`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${base}/speed`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);

    const traffic = await trafficRes.json();
    const speed = speedRes ? await speedRes.json().catch(() => null) : null;

    return {
      traffic,
      speed,
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    set.status = 502; return { error: `avengers unreachable: ${err.message}` };
  }
});

// GET /api/avengers/health -- quick health check
avengersApi.get("/avengers/health", async () => {
  const base = getAvengersUrl();
  if (!base) return { configured: false, reachable: false };

  try {
    const start = Date.now();
    const res = await fetch(`${base}/all`, { signal: AbortSignal.timeout(3000) });
    const latency = Date.now() - start;
    const accounts = await res.json();

    return {
      configured: true,
      reachable: res.ok,
      latency,
      accounts: Array.isArray(accounts) ? accounts.length : 0,
      url: base,
    };
  } catch {
    return { configured: true, reachable: false, url: base };
  }
});
