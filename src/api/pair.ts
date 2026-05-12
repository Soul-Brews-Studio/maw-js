/**
 * Pair API — HTTP surface for federation pairing (#573).
 *   POST /pair/generate      mint code (ttlMs default 120000)
 *   GET  /pair/:code/probe   200 iff live (LAN discovery)
 *   POST /pair/:code         acceptor submits identity → handshake
 *   GET  /pair/:code/status  initiator polls for consumption
 * Initiator-side peer write happens here; acceptor writes in CLI.
 */

import { Elysia } from "elysia";
import { randomBytes } from "crypto";
import { loadConfig } from "../config";
import { register, lookup, consume, isValidShape, normalize, pretty, generateCode } from "../lib/pair-codes";
import { cmdAdd } from "../lib/peers/impl";
import { loadPeers } from "../lib/peers/store";
import { getCurrentScout } from "../transports/scout";

export const pairApi = new Elysia();

const DEFAULT_TTL_MS = 120_000;
const results = new Map<string, { consumedAt: number; remoteNode: string; remoteUrl: string }>();

const me = () => { const c = loadConfig(); return { node: c.node ?? "local", port: c.port ?? 3456 }; };

pairApi.post("/pair/generate", ({ body, set }) => {
  const b = (body ?? {}) as { ttlMs?: number; expires?: number };
  const ttlMs = typeof b.ttlMs === "number" ? b.ttlMs
    : typeof b.expires === "number" ? b.expires * 1000 : DEFAULT_TTL_MS;
  const entry = register(generateCode(), ttlMs);
  const id = me();
  set.status = 201;
  return { ok: true, code: pretty(entry.code), expiresAt: entry.expiresAt, ttlMs, node: id.node, port: id.port };
});

pairApi.get("/pair/:code/probe", ({ params, set }) => {
  if (!isValidShape(params.code)) { set.status = 400; return { ok: false, error: "invalid_shape" }; }
  const r = lookup(params.code);
  if (!r.ok) { set.status = r.reason === "not_found" ? 404 : 410; return { ok: false, error: r.reason }; }
  return { ok: true, node: me().node };
});

pairApi.post("/pair/:code", async ({ params, body, set }) => {
  if (!isValidShape(params.code)) { set.status = 400; return { ok: false, error: "invalid_shape" }; }
  const b = (body ?? {}) as { node?: string; url?: string };
  if (typeof b.node !== "string" || typeof b.url !== "string" || !b.node || !b.url) {
    set.status = 400; return { ok: false, error: "bad_request" };
  }
  const r = consume(params.code);
  if (!r.ok) { set.status = r.reason === "not_found" ? 404 : 410; return { ok: false, error: r.reason }; }
  const id = me();
  try { await cmdAdd({ alias: b.node, url: b.url, node: b.node }); } catch { /* ignore bad remote */ }
  results.set(normalize(params.code), { consumedAt: Date.now(), remoteNode: b.node, remoteUrl: b.url });
  return { ok: true, node: id.node, url: `http://localhost:${id.port}`, federationToken: randomBytes(32).toString("hex") };
});

pairApi.get("/pair/:code/status", ({ params, set }) => {
  const code = normalize(params.code);
  const rec = results.get(code);
  if (rec) return { ok: true, consumed: true, remoteNode: rec.remoteNode, remoteUrl: rec.remoteUrl };
  const r = lookup(code);
  if (!r.ok && r.reason === "not_found") { set.status = 404; return { ok: false, error: "not_found" }; }
  if (!r.ok && r.reason === "expired") { set.status = 410; return { ok: false, error: "expired" }; }
  return { ok: true, consumed: false };
});

export function _resetResults(): void { results.clear(); }

// ─── Auto-pair (scout discovery) ─────────────────────────────────────

const recentHellos = new Map<string, number>();
const HELLO_WINDOW_MS = 60_000;

/** Called by ScoutTransport when a Hello is received, to track zid for anti-replay */
export function recordHelloZid(zid: string): void {
  recentHellos.set(zid, Date.now());
  // prune old entries
  const cutoff = Date.now() - HELLO_WINDOW_MS;
  for (const [k, v] of recentHellos) {
    if (v < cutoff) recentHellos.delete(k);
  }
}

// ─── Discovery snapshot + accept (#1237) ─────────────────────────────────
//
// `GET /api/peers/discoveries` exposes the in-memory `ScoutState.discoveredPeers`
// map so the CLI's `maw peers list --discovered` can render LAN candidates
// without polling multicast itself.
//
// `POST /api/peers/accept` is the operator-facing primitive — given a zid
// (full or prefix) or a node name, derive the locator URL from the snapshot
// and call cmdAdd(). Decision #4 of the design (impersonation guard): refuse
// when the candidate's cached pubkey already pins under a different alias.

interface DiscoveriesQuery { all?: string; limit?: string }

function relSeen(ms: number, now: number): string {
  const dt = Math.max(0, now - ms);
  if (dt < 1000) return "now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

pairApi.get("/peers/discoveries", ({ query, set }) => {
  const scout = getCurrentScout();
  if (!scout) {
    // Open question #1 in the design — daemon down OR scout transport not
    // currently bound (e.g. multicast bind failed). Hard error, no stale
    // fallback. CLI surfaces this as "discovery unavailable".
    set.status = 503;
    return { ok: false, error: "scout_unavailable", hint: "Scout transport not bound — restart `maw serve` or check multicast binding." };
  }
  const q = (query ?? {}) as DiscoveriesQuery;
  const includeAll = q.all === "1" || q.all === "true";
  const limit = Number.isFinite(Number(q.limit)) && Number(q.limit) > 0
    ? Math.min(Number(q.limit), 500)
    : 50;

  const now = Date.now();
  const all = scout.discoveriesSnapshot();
  const filtered = includeAll ? all : all.filter(p => !p.paired);
  const sliced = filtered.slice(0, limit);
  return {
    ok: true,
    total: all.length,
    shown: sliced.length,
    filtered: !includeAll,
    peers: sliced.map(p => ({
      zid: p.zid,
      node: p.node,
      oracle: p.oracle,
      host: p.host,
      locators: p.locators,
      capabilities: p.capabilities,
      oracles: p.oracles,
      firstSeen: new Date(p.firstSeen).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString(),
      seenRel: relSeen(p.lastSeen, now),
      paired: p.paired,
    })),
  };
});

/**
 * Resolve a candidate by zid (full or shortest unambiguous prefix) or node
 * name. Mirrors decision #3 of the design — ambiguous prefix returns the
 * full candidate list so the CLI can render them and abort.
 */
function resolveCandidate(id: string, snapshot: ReturnType<NonNullable<ReturnType<typeof getCurrentScout>>["discoveriesSnapshot"]>) {
  const exactZid = snapshot.find(p => p.zid === id);
  if (exactZid) return { kind: "match" as const, peer: exactZid };
  const exactNode = snapshot.filter(p => p.node === id);
  if (exactNode.length === 1) return { kind: "match" as const, peer: exactNode[0] };
  if (exactNode.length > 1) return { kind: "ambiguous" as const, candidates: exactNode };
  const prefixZid = snapshot.filter(p => p.zid.startsWith(id));
  if (prefixZid.length === 1) return { kind: "match" as const, peer: prefixZid[0] };
  if (prefixZid.length > 1) return { kind: "ambiguous" as const, candidates: prefixZid };
  return { kind: "not_found" as const };
}

pairApi.post("/peers/accept", async ({ body, set }) => {
  const scout = getCurrentScout();
  if (!scout) {
    set.status = 503;
    return { ok: false, error: "scout_unavailable" };
  }
  const b = (body ?? {}) as { id?: string; alias?: string; all?: boolean };
  const snapshot = scout.discoveriesSnapshot();

  // ─── --all branch: accept every unpaired candidate ────────────────────
  if (b.all) {
    const targets = snapshot.filter(p => !p.paired);
    if (targets.length === 0) return { ok: true, accepted: [], skipped: [], message: "no unpaired discoveries" };
    const results: Array<{ id: string; ok: boolean; alias?: string; error?: string }> = [];
    // Open question #3 — concurrency cap matches probe-all (8 parallel).
    const CONCURRENCY = 8;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(p => acceptOne(p, undefined)));
      results.push(...batchResults);
    }
    return {
      ok: true,
      accepted: results.filter(r => r.ok),
      skipped: results.filter(r => !r.ok),
    };
  }

  // ─── Single-target branch ─────────────────────────────────────────────
  if (!b.id) {
    set.status = 400;
    return { ok: false, error: "missing_id", hint: "Pass { id } (zid, zid prefix, or node name) or { all: true }." };
  }
  const resolved = resolveCandidate(b.id, snapshot);
  if (resolved.kind === "not_found") {
    set.status = 404;
    return { ok: false, error: "not_found", hint: `No discovered peer matches "${b.id}".` };
  }
  if (resolved.kind === "ambiguous") {
    set.status = 409;
    return {
      ok: false,
      error: "ambiguous",
      candidates: resolved.candidates.map(c => ({ zid: c.zid, node: c.node, host: c.host })),
      hint: "Disambiguate with a longer zid prefix or unique node name.",
    };
  }

  const result = await acceptOne(resolved.peer, b.alias);
  if (!result.ok) {
    set.status = result.status ?? 400;
    return { ok: false, error: result.error, hint: result.hint };
  }
  return { ok: true, alias: result.alias, node: resolved.peer.node, url: result.url };
});

/**
 * Inner accept worker — runs the impersonation guard then cmdAdd. Returns a
 * uniform shape for both single and --all paths.
 *
 * Decision #4 (impersonation guard): we probe the candidate's `/api/identity`
 * via cmdAdd's built-in probe. After the probe (which returns pubkey),
 * cross-check against every other alias in peers.json: if any other alias
 * pins this exact pubkey, refuse — the operator is about to give a duplicate
 * key two different aliases, which is precisely the peer-with-same-name
 * attack the guard exists to block.
 */
async function acceptOne(
  peer: { zid: string; node: string; oracle: string; locators: string[] },
  aliasOverride: string | undefined,
): Promise<{ ok: true; alias: string; url: string } | { ok: false; error: string; hint?: string; status?: number; id: string }> {
  const id = peer.zid;
  const url = peer.locators[0];
  if (!url) return { ok: false, error: "no_locator", hint: "Hello carried no locator URL.", status: 400, id };
  const alias = aliasOverride ?? peer.node;
  try {
    const res = await cmdAdd({ alias, url, node: peer.node });
    if (res.pubkeyMismatch) {
      return {
        ok: false,
        error: "pubkey_mismatch",
        hint: `${res.pubkeyMismatch.message} — re-pin via \`maw peers forget ${alias}\` if rotation was intentional.`,
        status: 409,
        id,
      };
    }
    // Impersonation guard (decision #4) — same pubkey under different alias.
    const observedPubkey = res.peer.pubkey;
    if (observedPubkey) {
      const allPeers = loadPeers().peers;
      for (const [otherAlias, p] of Object.entries(allPeers)) {
        if (otherAlias === alias) continue;
        if (p.pubkey && p.pubkey === observedPubkey) {
          // We already wrote `alias` in cmdAdd — back it out so the guard
          // is genuinely refusal (not "accept-and-warn"). Use mutate to
          // stay atomic with concurrent peer writes.
          const { mutatePeers } = await import("../lib/peers/store");
          mutatePeers((d) => { delete d.peers[alias]; });
          return {
            ok: false,
            error: "impersonation_guard",
            hint: `pubkey already pins under alias "${otherAlias}". Use --alias <new> if intentional, or \`maw peers forget ${otherAlias}\` if rotating.`,
            status: 409,
            id,
          };
        }
      }
    }
    if (res.probeError) {
      // Probe failed but cmdAdd wrote the alias anyway (well-known behavior).
      // Surface the error but report ok — operator will see lastError on
      // `peers info`.
      return { ok: true, alias, url };
    }
    return { ok: true, alias, url };
  } catch (e: unknown) {
    return {
      ok: false,
      error: "add_failed",
      hint: e instanceof Error ? e.message : String(e),
      status: 400,
      id,
    };
  }
}

pairApi.post("/pair/auto", async ({ body, set }) => {
  const b = (body ?? {}) as { node?: string; oracle?: string; url?: string; zid?: string; capabilities?: string[] };

  if (!b.node || !b.url || !b.zid) {
    set.status = 400;
    return { ok: false, error: "missing_fields" };
  }

  // anti-replay: must have seen a Hello from this zid recently
  const helloTs = recentHellos.get(b.zid);
  if (!helloTs || Date.now() - helloTs > HELLO_WINDOW_MS) {
    set.status = 403;
    return { ok: false, error: "no_recent_hello" };
  }

  const id = me();
  try {
    await cmdAdd({ alias: b.node, url: b.url, node: b.node });
  } catch {}

  recentHellos.delete(b.zid);

  return {
    ok: true,
    node: id.node,
    oracle: "mawjs",
    url: `http://localhost:${id.port}`,
  };
});
