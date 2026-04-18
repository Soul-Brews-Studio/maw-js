/**
 * Pair discovery — resolve code → peer URL (#573).
 * Try order: explicit --at → (mDNS slot reserved — no dep) → LAN /24 scan.
 * Scans 192.168.0/1.0/24 and 10.0.0.0/24; exotic networks use --at.
 */

export interface DiscoveryOptions { at?: string; port?: number; timeoutMs?: number }
export interface DiscoveryHit { url: string; method: "explicit" | "mdns" | "lan-scan" }

const DEFAULT_RANGES = ["192.168.0.", "192.168.1.", "10.0.0."];

async function probe(baseUrl: string, code: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(`/api/pair/${encodeURIComponent(code)}/probe`, baseUrl), { signal: ctrl.signal });
    return res.status === 200;
  } catch { return false; } finally { clearTimeout(t); }
}

export async function discover(code: string, opts: DiscoveryOptions = {}): Promise<DiscoveryHit | null> {
  const port = opts.port ?? 3456;
  const timeoutMs = opts.timeoutMs ?? 400;

  if (opts.at) {
    const ok = await probe(opts.at, code, timeoutMs);
    return ok ? { url: opts.at, method: "explicit" } : null;
  }

  // mDNS slot reserved — no bonjour/multicast-dns in deps. Skip.

  const candidates: string[] = [];
  for (const base of DEFAULT_RANGES) {
    for (let i = 1; i < 255; i++) candidates.push(`http://${base}${i}:${port}`);
  }
  const CAP = 64;
  for (let i = 0; i < candidates.length; i += CAP) {
    const batch = candidates.slice(i, i + CAP);
    const results = await Promise.all(batch.map(u => probe(u, code, timeoutMs).then(ok => ({ u, ok }))));
    const hit = results.find(r => r.ok);
    if (hit) return { url: hit.u, method: "lan-scan" };
  }
  return null;
}

export async function fetchNodeName(baseUrl: string, timeoutMs = 2000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/api/identity", baseUrl), { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = await res.json() as { node?: unknown };
    return typeof body.node === "string" ? body.node : null;
  } catch { return null; } finally { clearTimeout(t); }
}
