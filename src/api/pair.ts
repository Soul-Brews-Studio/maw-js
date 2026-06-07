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
import { getPeerKey } from "../lib/peer-key";
import { signAutoPairProof, type AutoPairIdentity } from "../transports/scout-pair-proof";

const DEFAULT_TTL_MS = 120_000;
const results = new Map<string, { consumedAt: number; remoteNode: string; remoteUrl: string }>();

export interface PairApiDeps {
  loadConfig: typeof loadConfig;
  randomBytes: typeof randomBytes;
  register: typeof register;
  lookup: typeof lookup;
  consume: typeof consume;
  isValidShape: typeof isValidShape;
  normalize: typeof normalize;
  pretty: typeof pretty;
  generateCode: typeof generateCode;
  cmdAdd: typeof cmdAdd;
  getPeerKey: typeof getPeerKey;
  signAutoPairProof: typeof signAutoPairProof;
  now: () => number;
}

const me = (deps: Pick<PairApiDeps, "loadConfig">) => {
  const c = deps.loadConfig();
  return { node: c.node ?? "local", oracle: c.oracle ?? "mawjs", port: c.port ?? 3456 };
};

// ─── Auto-pair (scout discovery) ─────────────────────────────────────

const recentHellos = new Map<string, number>();
const HELLO_WINDOW_MS = 60_000;

/** Called by ScoutTransport when a Hello is received, to track zid for anti-replay */
export function recordHelloZid(zid: string, now = Date.now()): void {
  recentHellos.set(zid, now);
  // prune old entries
  const cutoff = now - HELLO_WINDOW_MS;
  for (const [k, v] of recentHellos) {
    if (v < cutoff) recentHellos.delete(k);
  }
}

export function _resetResults(): void {
  results.clear();
  recentHellos.clear();
}

export function createPairApi(deps: PairApiDeps = {
  loadConfig,
  randomBytes,
  register,
  lookup,
  consume,
  isValidShape,
  normalize,
  pretty,
  generateCode,
  cmdAdd,
  getPeerKey,
  signAutoPairProof,
  now: Date.now,
}) {
  const api = new Elysia();

  api.post("/pair/generate", ({ body, set }) => {
    const b = (body ?? {}) as { ttlMs?: number; expires?: number };
    const ttlMs = typeof b.ttlMs === "number" ? b.ttlMs
      : typeof b.expires === "number" ? b.expires * 1000 : DEFAULT_TTL_MS;
    const entry = deps.register(deps.generateCode(), ttlMs);
    const id = me(deps);
    set.status = 201;
    return { ok: true, code: deps.pretty(entry.code), expiresAt: entry.expiresAt, ttlMs, node: id.node, port: id.port };
  });

  api.get("/pair/:code/probe", ({ params, set }) => {
    if (!deps.isValidShape(params.code)) { set.status = 400; return { ok: false, error: "invalid_shape" }; }
    const r = deps.lookup(params.code);
    if (!r.ok) { set.status = r.reason === "not_found" ? 404 : 410; return { ok: false, error: r.reason }; }
    return { ok: true, node: me(deps).node };
  });

  api.post("/pair/:code", async ({ params, body, set }) => {
    if (!deps.isValidShape(params.code)) { set.status = 400; return { ok: false, error: "invalid_shape" }; }
    const b = (body ?? {}) as { node?: string; url?: string };
    if (typeof b.node !== "string" || typeof b.url !== "string" || !b.node || !b.url) {
      set.status = 400; return { ok: false, error: "bad_request" };
    }
    const r = deps.consume(params.code);
    if (!r.ok) { set.status = r.reason === "not_found" ? 404 : 410; return { ok: false, error: r.reason }; }
    const id = me(deps);
    try { await deps.cmdAdd({ alias: b.node, url: b.url, node: b.node }); } catch { /* ignore bad remote */ }
    results.set(deps.normalize(params.code), { consumedAt: deps.now(), remoteNode: b.node, remoteUrl: b.url });
    return { ok: true, node: id.node, url: `http://localhost:${id.port}`, federationToken: deps.randomBytes(32).toString("hex") };
  });

  api.get("/pair/:code/status", ({ params, set }) => {
    const code = deps.normalize(params.code);
    const rec = results.get(code);
    if (rec) return { ok: true, consumed: true, remoteNode: rec.remoteNode, remoteUrl: rec.remoteUrl };
    const r = deps.lookup(code);
    if (!r.ok && r.reason === "not_found") { set.status = 404; return { ok: false, error: "not_found" }; }
    if (!r.ok && r.reason === "expired") { set.status = 410; return { ok: false, error: "expired" }; }
    return { ok: true, consumed: false };
  });

  api.post("/pair/auto", async ({ body, set }) => {
    const b = (body ?? {}) as { node?: string; oracle?: string; url?: string; zid?: string; pubkey?: string; capabilities?: string[] };

    if (!b.node || !b.url || !b.zid) {
      set.status = 400;
      return { ok: false, error: "missing_fields" };
    }

    // anti-replay: must have seen a Hello from this zid recently
    const helloTs = recentHellos.get(b.zid);
    if (!helloTs || deps.now() - helloTs > HELLO_WINDOW_MS) {
      set.status = 403;
      return { ok: false, error: "no_recent_hello" };
    }

    const id = me(deps);
    let oneWay: boolean | undefined;
    try {
      const addResult = await deps.cmdAdd({
        alias: b.node,
        url: b.url,
        node: b.node,
        pubkey: typeof b.pubkey === "string" && b.pubkey.length > 0 ? b.pubkey : undefined,
        identity: b.oracle ? { oracle: b.oracle, node: b.node } : undefined,
        markSymmetricCheck: true,
      });
      if (addResult.pubkeyMismatch) {
        set.status = 409;
        return { ok: false, error: addResult.pubkeyMismatch.message };
      }
      oneWay = addResult.peer.oneWay;
    } catch (err) {
      set.status = 400;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    recentHellos.delete(b.zid);
    const config = deps.loadConfig();
    const pubkey = deps.getPeerKey();
    const url = `http://localhost:${id.port}`;
    const identity: AutoPairIdentity = {
      node: id.node,
      oracle: id.oracle,
      url,
      pubkey,
    };
    const proof = config.federationToken
      ? deps.signAutoPairProof(identity, config.federationToken)
      : undefined;

    return {
      ok: true,
      node: id.node,
      oracle: id.oracle,
      url,
      pubkey,
      proof,
      oneWay,
    };
  });

  return api;
}

export const pairApi = createPairApi();
