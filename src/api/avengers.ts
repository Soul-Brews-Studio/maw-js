/**
 * Avengers API proxy — bridges maw-js to ARRA-01/avengers rate limit monitor.
 *
 * Routes:
 *   GET /api/avengers/status    -> all accounts with rate limit info
 *   GET /api/avengers/best      -> account with most capacity
 *   GET /api/avengers/traffic   -> traffic stats across accounts
 */

import { Elysia } from "elysia";
import { loadConfig, type MawConfig } from "../config";

export interface AvengersApiDeps {
  loadConfig?: typeof loadConfig;
  fetch?: typeof fetch;
  nowIso?: () => string;
  nowMs?: () => number;
  timeoutSignal?: (ms: number) => AbortSignal;
}

/** Extract avengers base URL from config */
function getAvengersUrl(load: typeof loadConfig): string | null {
  const config = load() as MawConfig & { avengers?: string };
  return config.avengers || null;
}

export function createAvengersApi(deps: AvengersApiDeps = {}) {
  const load = deps.loadConfig ?? loadConfig;
  const fetchImpl = deps.fetch ?? fetch;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  const avengersApi = new Elysia();

  // GET /api/avengers/status -- all accounts with rate limit windows
  avengersApi.get("/avengers/status", async ({ set }) => {
    const base = getAvengersUrl(load);
    if (!base) { set.status = 503; return { error: "avengers not configured" }; }

    try {
      const res = await fetchImpl(`${base}/all`, { signal: timeoutSignal(5000) });
      const accounts = await res.json();
      return {
        accounts,
        total: Array.isArray(accounts) ? accounts.length : 0,
        source: base,
        timestamp: nowIso(),
      };
    } catch (err: any) {
      set.status = 502; return { error: `avengers unreachable: ${err.message}` };
    }
  });

  // GET /api/avengers/best -- account with most remaining capacity
  avengersApi.get("/avengers/best", async ({ set }) => {
    const base = getAvengersUrl(load);
    if (!base) { set.status = 503; return { error: "avengers not configured" }; }

    try {
      const res = await fetchImpl(`${base}/best`, { signal: timeoutSignal(5000) });
      const best = await res.json();
      return best;
    } catch (err: any) {
      set.status = 502; return { error: `avengers unreachable: ${err.message}` };
    }
  });

  // GET /api/avengers/traffic -- traffic stats per account
  avengersApi.get("/avengers/traffic", async ({ set }) => {
    const base = getAvengersUrl(load);
    if (!base) { set.status = 503; return { error: "avengers not configured" }; }

    try {
      const [trafficRes, speedRes] = await Promise.all([
        fetchImpl(`${base}/traffic-stats`, { signal: timeoutSignal(5000) }),
        fetchImpl(`${base}/speed`, { signal: timeoutSignal(5000) }).catch(() => null),
      ]);

      const traffic = await trafficRes.json();
      const speed = speedRes ? await speedRes.json().catch(() => null) : null;

      return {
        traffic,
        speed,
        timestamp: nowIso(),
      };
    } catch (err: any) {
      set.status = 502; return { error: `avengers unreachable: ${err.message}` };
    }
  });

  // GET /api/avengers/health -- quick health check
  avengersApi.get("/avengers/health", async () => {
    const base = getAvengersUrl(load);
    if (!base) return { configured: false, reachable: false };

    try {
      const start = nowMs();
      const res = await fetchImpl(`${base}/all`, { signal: timeoutSignal(3000) });
      const latency = nowMs() - start;
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

  return avengersApi;
}

export const avengersApi = createAvengersApi();
