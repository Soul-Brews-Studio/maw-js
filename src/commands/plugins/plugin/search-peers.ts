/**
 * Federated plugin search (#631, Shape A).
 *
 * `searchPeers(query, opts)` fans out across configured peers, asks each
 * `GET /api/plugin/list-manifest` for their locally-installed plugins, and
 * returns a merged + deduped + sorted hit list.
 *
 * - Per-peer timeout (default 2000 ms) and total budget (default 4000 ms)
 *   keep the command bounded; offline peers degrade to `errors[]`, never
 *   to an exception.
 * - Per-peer cache at `~/.maw/peer-manifest-cache/<urlsafe>.json` (5-min TTL,
 *   mirrors the pattern in registry-fetch.ts).
 * - All network I/O is injectable so tests don't need real HTTP.
 *
 * Spec: docs/plugins/search-peers-impl.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { loadConfig } from "../../../config";
import { curlFetch, type CurlResponse } from "../../../core/transport/curl-fetch";
import { getPeers } from "../../../core/transport/peers";
import type { PeerPluginEntry, PeerManifestResponse } from "../../../api/plugin-list-manifest";

export const DEFAULT_PER_PEER_MS = 2000;
export const DEFAULT_TOTAL_MS = 4000;
export const PEER_CACHE_TTL_MS = 5 * 60 * 1000;

export interface PluginSearchHit {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  peerName?: string;
  peerUrl: string;
  peerNode?: string;
  sha256?: string | null;
  /**
   * True when the peer's self-reported `manifest.node` disagrees with the
   * config-trusted `namedPeers[].name` (#651). When set, callers should treat
   * `peerNode` as attacker-controlled and refuse to route install/trust
   * decisions through it.
   */
  identityMismatch?: boolean;
}

export interface PeerError {
  peerUrl: string;
  peerName?: string;
  reason: "timeout" | "unreachable" | "bad-response" | "http-error";
  detail?: string;
}

export interface SearchPeersResult {
  hits: PluginSearchHit[];
  queried: number;
  responded: number;
  errors: PeerError[];
  elapsedMs: number;
}

export interface SearchPeersOpts {
  /** Limit to a single peer by `namedPeers[].name`. */
  peer?: string;
  /** Per-peer timeout (ms). Default 2000. */
  perPeerMs?: number;
  /** Total budget across all peers (ms). Default 4000. */
  totalMs?: number;
  /** Injectable fetch (tests). Defaults to curlFetch. */
  fetch?: typeof curlFetch;
  /** Injectable peer list (tests). Defaults to getPeers()/namedPeers lookup. */
  peers?: Array<{ url: string; name?: string }>;
  /** Skip cache reads/writes (tests + `--no-cache`). */
  noCache?: boolean;
  /** Override cache dir (tests). Defaults to ~/.maw/peer-manifest-cache. */
  cacheDir?: string;
}

interface CacheFile {
  url: string;
  fetchedAt: string;
  manifest: PeerManifestResponse;
}

export function peerCacheDir(override?: string): string {
  if (override) return override;
  return process.env.MAW_PEER_CACHE_DIR ?? join(homedir(), ".maw", "peer-manifest-cache");
}

function urlSafeKey(url: string): string {
  return encodeURIComponent(url).replace(/%/g, "_");
}

function peerCachePath(url: string, dir?: string): string {
  return join(peerCacheDir(dir), `${urlSafeKey(url)}.json`);
}

function isManifest(v: unknown): v is PeerManifestResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 1) return false;
  if (typeof o.node !== "string") return false;
  if (!Array.isArray(o.plugins)) return false;
  for (const p of o.plugins) {
    if (!p || typeof p !== "object") return false;
    const e = p as Record<string, unknown>;
    if (typeof e.name !== "string" || typeof e.version !== "string") return false;
  }
  return true;
}

function readPeerCache(url: string, dir?: string): CacheFile | null {
  const p = peerCachePath(url, dir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
    if (!parsed || parsed.url !== url) return null;
    if (!isManifest(parsed.manifest)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePeerCache(url: string, manifest: PeerManifestResponse, dir?: string): void {
  const p = peerCachePath(url, dir);
  mkdirSync(dirname(p), { recursive: true });
  const body: CacheFile = { url, fetchedAt: new Date().toISOString(), manifest };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}

function isCacheFresh(cache: CacheFile, now = Date.now()): boolean {
  const age = now - new Date(cache.fetchedAt).getTime();
  return age >= 0 && age < PEER_CACHE_TTL_MS;
}

/** Resolve peers to query based on opts.peer / opts.peers / config. */
export function resolvePeers(opts: SearchPeersOpts): Array<{ url: string; name?: string }> {
  if (opts.peers) return opts.peers;
  const config = loadConfig();
  const named = config.namedPeers ?? [];

  if (opts.peer) {
    const match = named.find(p => p.name === opts.peer);
    if (!match) throw new Error(`unknown peer '${opts.peer}' — not in namedPeers`);
    return [{ url: match.url, name: match.name }];
  }

  const urls = getPeers();
  return urls.map(url => {
    const n = named.find(p => p.url === url);
    return n ? { url, name: n.name } : { url };
  });
}

interface FetchOutcome {
  ok: boolean;
  manifest?: PeerManifestResponse;
  error?: PeerError;
}

async function fetchPeerManifest(
  peer: { url: string; name?: string },
  perPeerMs: number,
  fetchImpl: typeof curlFetch,
  opts: SearchPeersOpts,
): Promise<FetchOutcome> {
  if (!opts.noCache) {
    const cached = readPeerCache(peer.url, opts.cacheDir);
    if (cached && isCacheFresh(cached)) {
      return { ok: true, manifest: cached.manifest };
    }
  }

  let res: CurlResponse;
  try {
    res = await fetchImpl(`${peer.url}/api/plugin/list-manifest`, { timeout: perPeerMs });
  } catch (err) {
    return {
      ok: false,
      error: {
        peerUrl: peer.url,
        peerName: peer.name,
        reason: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (!res.ok) {
    const reason: PeerError["reason"] = res.status === 0 ? "unreachable" : "http-error";
    return {
      ok: false,
      error: {
        peerUrl: peer.url,
        peerName: peer.name,
        reason,
        detail: `status ${res.status}`,
      },
    };
  }

  if (!isManifest(res.data)) {
    return {
      ok: false,
      error: {
        peerUrl: peer.url,
        peerName: peer.name,
        reason: "bad-response",
        detail: "missing schemaVersion=1/plugins[]",
      },
    };
  }

  if (!opts.noCache) {
    try {
      writePeerCache(peer.url, res.data, opts.cacheDir);
    } catch {
      // cache write failure is non-fatal
    }
  }
  return { ok: true, manifest: res.data };
}

/** Lowercase-substring match on name OR summary. */
function matches(q: string, entry: PeerPluginEntry): boolean {
  const needle = q.toLowerCase();
  if (entry.name.toLowerCase().includes(needle)) return true;
  if (entry.summary && entry.summary.toLowerCase().includes(needle)) return true;
  return false;
}

/**
 * Fan out across peers and merge plugin search results.
 *
 * Returns aggregate result even when every peer fails — errors are surfaced
 * via `errors[]`, never thrown. Only throws for caller-fault conditions
 * (unknown `--peer <name>`).
 */
export async function searchPeers(
  query: string,
  opts: SearchPeersOpts = {},
): Promise<SearchPeersResult> {
  const start = Date.now();
  const perPeerMs = opts.perPeerMs ?? DEFAULT_PER_PEER_MS;
  const totalMs = opts.totalMs ?? DEFAULT_TOTAL_MS;
  const fetchImpl = opts.fetch ?? curlFetch;

  const peers = resolvePeers(opts);
  if (peers.length === 0) {
    return { hits: [], queried: 0, responded: 0, errors: [], elapsedMs: Date.now() - start };
  }

  const perPeer = peers.map(p => fetchPeerManifest(p, perPeerMs, fetchImpl, opts));
  const totalBudget = new Promise<FetchOutcome[]>(resolve => {
    setTimeout(() => {
      resolve(
        peers.map(p => ({
          ok: false,
          error: {
            peerUrl: p.url,
            peerName: p.name,
            reason: "timeout",
            detail: `total budget ${totalMs}ms exceeded`,
          },
        })),
      );
    }, totalMs);
  });
  const outcomes = await Promise.race([Promise.all(perPeer), totalBudget]);

  const hits: PluginSearchHit[] = [];
  const errors: PeerError[] = [];
  let responded = 0;

  outcomes.forEach((outcome, idx) => {
    const peer = peers[idx]!;
    if (outcome.ok && outcome.manifest) {
      responded++;
      // Cross-check peer identity (#651): if the config pins this peer to a
      // name, the peer's self-reported manifest.node should match. A hostile
      // peer at a known URL can otherwise forge another oracle's name in
      // every hit.
      const identityMismatch =
        peer.name != null && outcome.manifest.node !== peer.name;
      if (identityMismatch) {
        console.warn(
          `[search-peers] identity mismatch: ${peer.url} (configured as '${peer.name}') ` +
          `reports node='${outcome.manifest.node}' — treating peerNode as untrusted`,
        );
      }
      for (const entry of outcome.manifest.plugins) {
        if (!matches(query, entry)) continue;
        const hit: PluginSearchHit = {
          name: entry.name,
          version: entry.version,
          peerUrl: peer.url,
          peerNode: outcome.manifest.node,
        };
        if (entry.summary) hit.summary = entry.summary;
        if (entry.author) hit.author = entry.author;
        if (peer.name) hit.peerName = peer.name;
        if (entry.sha256 !== undefined) hit.sha256 = entry.sha256;
        if (identityMismatch) hit.identityMismatch = true;
        hits.push(hit);
      }
    } else if (outcome.error) {
      errors.push(outcome.error);
    }
  });

  const seen = new Set<string>();
  const deduped = hits.filter(h => {
    const key = `${h.name}@${h.version}@${h.peerUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.version.localeCompare(b.version);
  });

  return {
    hits: deduped,
    queried: peers.length,
    responded,
    errors,
    elapsedMs: Date.now() - start,
  };
}
