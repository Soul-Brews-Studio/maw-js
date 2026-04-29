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
