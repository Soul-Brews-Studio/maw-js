/**
 * Pair codes — gen, shape, TTL, single-use (#573).
 * 32-char reduced alphabet (no I/O/0/1/l). 6 chars = 30 bits entropy.
 */

export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface PairEntry {
  code: string;          // normalized: no hyphen, upper-case
  expiresAt: number;
  consumed: boolean;
  createdAt: number;
}

export function normalize(raw: string): string {
  return raw.replace(/[-\s]/g, "").toUpperCase();
}

export function isValidShape(code: string): boolean {
  const c = normalize(code);
  if (c.length !== 6) return false;
  for (const ch of c) if (!ALPHABET.includes(ch)) return false;
  return true;
}

export function pretty(code: string): string {
  const c = normalize(code);
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

export function redact(code: string): string {
  const c = normalize(code);
  return c.length >= 3 ? `${c.slice(0, 3)}-***` : "***";
}

export function generateCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

const store = new Map<string, PairEntry>();

export function register(code: string, ttlMs: number): PairEntry {
  const entry: PairEntry = { code: normalize(code), expiresAt: Date.now() + ttlMs, consumed: false, createdAt: Date.now() };
  store.set(entry.code, entry);
  return entry;
}

export type LookupResult = { ok: true; entry: PairEntry } | { ok: false; reason: "not_found" | "expired" | "consumed" };

export function lookup(code: string): LookupResult {
  const entry = store.get(normalize(code));
  if (!entry) return { ok: false, reason: "not_found" };
  if (entry.consumed) return { ok: false, reason: "consumed" };
  if (Date.now() > entry.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, entry };
}

/** Atomically mark consumed. */
export function consume(code: string): LookupResult {
  const r = lookup(code);
  if (!r.ok) return r;
  r.entry.consumed = true;
  return r;
}

export function _resetStore(): void { store.clear(); }
export function _inject(entry: PairEntry): void { store.set(entry.code, entry); }
