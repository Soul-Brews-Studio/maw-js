/**
 * maw peers — discovery client (#1237, slice 1).
 *
 * Thin HTTP client over the maw-js daemon's `/api/peers/discoveries` +
 * `/api/peers/accept` endpoints. CLI-facing — no store mutation here;
 * the daemon owns the canonical write path (cmdAdd + impersonation
 * guard). This module just renders responses and surfaces errors.
 *
 * Daemon URL: derived from `loadConfig().port` per the same pattern
 * `plugins/health` uses. Open question #1 from the design: when the
 * daemon is down we report `daemon_unreachable` — no stale fallback.
 */
import { loadConfig } from "maw-js/config";

export interface DiscoveryRow {
  zid: string;
  node: string;
  oracle: string;
  host: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  firstSeen: string;
  lastSeen: string;
  seenRel: string;
  paired: boolean;
}

export interface DiscoveryResponse {
  ok: true;
  total: number;
  shown: number;
  filtered: boolean;
  peers: DiscoveryRow[];
}

export interface DiscoveryError {
  ok: false;
  /** "daemon_unreachable" — daemon not running. "scout_unavailable" — daemon up but multicast unbound. */
  error: string;
  hint?: string;
  /** HTTP status if the daemon responded but with an error. */
  status?: number;
}

function daemonBase(): string {
  const port = loadConfig().port ?? 3456;
  return `http://localhost:${port}`;
}

const TIMEOUT_MS = 5_000;

export async function fetchDiscoveries(opts: { all?: boolean; limit?: number } = {}): Promise<DiscoveryResponse | DiscoveryError> {
  const qs = new URLSearchParams();
  if (opts.all) qs.set("all", "1");
  if (opts.limit) qs.set("limit", String(opts.limit));
  const url = `${daemonBase()}/api/peers/discoveries${qs.toString() ? "?" + qs : ""}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e: unknown) {
    return {
      ok: false,
      error: "daemon_unreachable",
      hint: `${e instanceof Error ? e.message : String(e)} — is \`maw serve\` running?`,
    };
  }
  if (!res.ok) {
    const body = await safeJson(res);
    if (res.status === 404) {
      return {
        ok: false,
        error: "discovery_endpoint_missing",
        hint: "daemon doesn't expose /api/peers/discoveries — restart `maw serve` after upgrading",
        status: 404,
      };
    }
    return {
      ok: false,
      error: body?.error ?? `http_${res.status}`,
      hint: body?.hint,
      status: res.status,
    };
  }
  return (await res.json()) as DiscoveryResponse;
}

export interface AcceptResponse {
  ok: true;
  alias?: string;
  node?: string;
  url?: string;
  accepted?: Array<{ alias?: string; ok: true }>;
  skipped?: Array<{ id: string; error: string; hint?: string }>;
  message?: string;
}

export async function acceptPeer(opts: { id?: string; alias?: string; all?: boolean }): Promise<AcceptResponse | DiscoveryError> {
  const url = `${daemonBase()}/api/peers/accept`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: unknown) {
    return {
      ok: false,
      error: "daemon_unreachable",
      hint: `${e instanceof Error ? e.message : String(e)} — is \`maw serve\` running?`,
    };
  }
  if (!res.ok) {
    const body = await safeJson(res);
    return {
      ok: false,
      error: body?.error ?? `http_${res.status}`,
      hint: body?.hint,
      status: res.status,
      ...(body?.candidates ? { candidates: body.candidates } : {}),
    } as DiscoveryError;
  }
  return (await res.json()) as AcceptResponse;
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

/**
 * Render a discoveries response as a fixed-width table matching decision #5
 * of the design: `zid | node | oracle | host | seen | paired | caps`.
 */
export function formatDiscoveries(resp: DiscoveryResponse): string {
  if (resp.peers.length === 0) {
    return resp.filtered
      ? "no unpaired discoveries (pass --all to include already-paired)"
      : "no discoveries";
  }
  const header = ["zid", "node", "oracle", "host", "seen", "paired", "caps"];
  const rows = resp.peers.map(p => [
    p.zid.slice(0, 8) + "…",
    p.node ?? "-",
    p.oracle ?? "-",
    p.host,
    p.seenRel,
    p.paired ? "✓" : "-",
    p.capabilities.join(",") || "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const lines = [fmt(header), fmt(widths.map(w => "-".repeat(w))), ...rows.map(fmt)];
  if (resp.total > resp.shown) {
    lines.push("", `(${resp.shown}/${resp.total} shown — pass --limit N to widen)`);
  }
  return lines.join("\n");
}
