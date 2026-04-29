/**
 * maw peers — handshake probe + error classifier (#565).
 *
 * Replaces the silent try/catch→null in resolveNode(). probePeer()
 * fetches <url>/info, classifies failures into a small enum, and
 * returns both resolved node (if any) and structured error (if any).
 * The old resolveNode() wrapper in impl.ts is kept as a thin
 * `string | null` fallback for pre-#565 call sites.
 */
import type { LastError } from "./store";
import { lookup } from "dns/promises";

export type ProbeErrorCode = LastError["code"];

export interface ProbeResult {
  node: string | null;
  /** Peer's self-reported nickname from /info (#643 Phase 2). Null means peer did not advertise one. */
  nickname?: string | null;
  /**
   * Peer's pubkey from /api/identity (#804 Step 2). Undefined when:
   *   - the /info handshake itself failed (no second fetch attempted), OR
   *   - the peer is pre-Step-1 and does not expose /api/identity, OR
   *   - /api/identity responded but did not advertise a pubkey field.
   *
   * Caller passes this through `tofuRecordPeerIdentity` to pin / validate.
   */
  pubkey?: string;
  /**
   * Peer's self-reported `<oracle>:<node>` from /api/identity (#804 Step 3).
   *
   * Captured opportunistically alongside `pubkey` so the local cache can
   * detect duplicate-claim collisions across peers (e.g. two peers both
   * declaring themselves `mawjs:m5`). Undefined when /api/identity did not
   * respond or omitted both `oracle` and `node` fields.
   *
   * `oracle` defaults to `"mawjs"` when the response only carries `node` —
   * this is the family default per ADR docs/federation/0001-peer-identity.md
   * and lets pre-Step-3 peers still participate in the collision check.
   */
  identity?: { oracle: string; node: string };
  error?: LastError;
}

/**
 * Exit code per probe error family — fail-loud for scripts.
 *
 * Scripts that chain `maw peers add` with subsequent commands need a
 * non-zero exit to branch on. The old `ok:true + ⚠ block on stderr`
 * behavior was easy to miss in CI logs.
 *
 *   2 — generic/structural (UNKNOWN, BAD_BODY, TLS)
 *   3 — DNS (host does not resolve)
 *   4 — REFUSED (resolved but port closed)
 *   5 — TIMEOUT (no response in 2s)
 *   6 — HTTP_4XX / HTTP_5XX (peer responded but /info failed)
 */
export const PROBE_EXIT_CODES: Record<ProbeErrorCode, number> = {
  DNS: 3,
  REFUSED: 4,
  TIMEOUT: 5,
  HTTP_4XX: 6,
  HTTP_5XX: 6,
  TLS: 2,
  BAD_BODY: 2,
  UNKNOWN: 2,
};

/** Actionable hint per error code — shown in CLI output. */
export const PROBE_HINTS: Record<ProbeErrorCode, string> = {
  DNS: "Host does not resolve. Check /etc/hosts, DNS, or VPN.",
  REFUSED: "Host resolves but port is closed. Is the peer process running?",
  TIMEOUT: "Peer did not respond within 2s. Network path may be blocked.",
  TLS: "TLS handshake failed. Check cert validity / chain.",
  HTTP_4XX: "Peer responded with a client error. /info endpoint may be missing OR peer is running an old maw version — if you control the peer, try restarting it.",
  HTTP_5XX: "Peer returned a server error. Server-side fault.",
  BAD_BODY: "/info responded but body shape was unexpected.",
  UNKNOWN: "Probe failed for an unclassified reason.",
};

/**
 * Classify a thrown fetch error OR a failed Response into a ProbeErrorCode.
 * Node/undici → err.cause.code; AbortError → 2s timeout; TLS → CERT_*;
 * HTTP → non-ok Response. Bun collapses DNS+refused → "ConnectionRefused";
 * run prefetchDnsCheck() first to recover the DNS distinction.
 */
export function classifyProbeError(input: unknown): ProbeErrorCode {
  // HTTP: non-ok Response
  if (typeof input === "object" && input !== null && "status" in input && "ok" in input) {
    const res = input as { status: number; ok: boolean };
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) return "HTTP_4XX";
      if (res.status >= 500) return "HTTP_5XX";
    }
  }

  // Thrown error: inspect cause.code, code, name
  const err = input as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (!err || typeof err !== "object") return "UNKNOWN";

  const code = err.cause?.code ?? err.code;
  // ENOTIMP = resolver method unimplemented (e.g. mDNS/.local without Avahi); EAI_FAIL = unrecoverable DNS (#593).
  if (code === "ENOTFOUND" || code === "ENOTIMP" || code === "EAI_FAIL" || code === "EAI_AGAIN" || code === "EAI_NODATA") return "DNS";
  // Bun conflates DNS + refused into "ConnectionRefused" — we run a DNS
  // precheck upstream, so any code that reaches here means connect failed.
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "REFUSED";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "TIMEOUT";
  if (err.name === "AbortError" || err.name === "TimeoutError") return "TIMEOUT";
  if (typeof code === "string" && (code.startsWith("CERT_") || code.startsWith("SELF_SIGNED") || code.startsWith("DEPTH_ZERO_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
    return "TLS";
  }

  return "UNKNOWN";
}

/**
 * DNS precheck — resolves host-doesn't-resolve vs connection-refused before
 * fetch (Bun conflates them). Returns DNS LastError on failure, null on ok.
 */
async function prefetchDnsCheck(url: string): Promise<LastError | null> {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return null; }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[")) return null;
  try {
    await lookup(hostname);
    return null;
  } catch (e: any) {
    return {
      code: classifyProbeError(e),
      message: typeof e?.message === "string" ? e.message : `DNS lookup failed for ${hostname}`,
      at: new Date().toISOString(),
    };
  }
}

/** Build a LastError record from a thrown error + url context. */
function errToLast(err: unknown, fallbackMsg: string): LastError {
  const code = classifyProbeError(err);
  const message = (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string")
    ? (err as any).message
    : fallbackMsg;
  return { code, message, at: new Date().toISOString() };
}

/**
 * Probe <url>/info with a 2s timeout. Success → { node } (body.node or
 * body.name). Failure → { node: null, error } — caller persists + warns.
 */
export async function probePeer(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  // DNS precheck first — cheaper than fetch and gives us clean ENOTFOUND
  // classification on Bun (whose fetch conflates DNS/refused into one code).
  const dnsErr = await prefetchDnsCheck(url);
  if (dnsErr) return { node: null, error: dnsErr };

  let res: Response;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      res = await fetch(new URL("/info", url), { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return { node: null, error: errToLast(e, `fetch ${url}/info failed`) };
  }

  if (!res.ok) {
    return {
      node: null,
      error: {
        code: classifyProbeError(res),
        message: `HTTP ${res.status} from ${url}/info`,
        at: new Date().toISOString(),
      },
    };
  }

  let body: { node?: unknown; name?: unknown; nickname?: unknown; maw?: unknown };
  try {
    body = await res.json() as { node?: unknown; name?: unknown; nickname?: unknown; maw?: unknown };
  } catch (e) {
    return {
      node: null,
      error: {
        code: "BAD_BODY",
        message: `/info body was not valid JSON`,
        at: new Date().toISOString(),
      },
    };
  }

  // Accept both the old handshake (#596 — `maw: true`) and the new
  // self-describing shape (#628 — `maw: { schema: "1", ... }`). Any
  // truthy `maw` value passes; missing/falsy fails as BAD_BODY so we
  // don't paint random HTTP 200 endpoints as maw peers.
  if (!isValidMawHandshake(body.maw)) {
    return {
      node: null,
      error: {
        code: "BAD_BODY",
        message: `/info response missing valid "maw" handshake field`,
        at: new Date().toISOString(),
      },
    };
  }

  const node = (typeof body.node === "string" && body.node)
    || (typeof body.name === "string" && body.name)
    || null;

  if (!node) {
    return {
      node: null,
      error: {
        code: "BAD_BODY",
        message: `/info response had neither "node" nor "name" string`,
        at: new Date().toISOString(),
      },
    };
  }

  // Nickname is optional and strictly cosmetic — only accept non-empty strings.
  const nickname = typeof body.nickname === "string" && body.nickname.length > 0
    ? body.nickname
    : null;

  // Best-effort pubkey + identity fetch (#804 Steps 2 + 3). Pre-Step-1 peers
  // don't expose /api/identity at all; we tolerate that and return without
  // either field — TOFU layer treats the result as a legacy peer, and the
  // duplicate-detection layer skips peers without identity (no false positive).
  const ident = await fetchPeerIdentityFields(url, timeoutMs);

  const result: ProbeResult = { node, nickname };
  if (ident?.pubkey) result.pubkey = ident.pubkey;
  if (ident?.identity) result.identity = ident.identity;
  return result;
}

/**
 * Best-effort second fetch — `/api/identity` (#804 Steps 2 + 3).
 *
 * Keep this *separate* from the /info handshake so a missing/older endpoint
 * does not poison the primary probe. We swallow every failure here: TOFU
 * only acts on a confirmed pubkey value, and the caller already classified
 * /info errors elsewhere.
 *
 * Returns whatever subset of `{ pubkey, identity }` the response advertised,
 * or `undefined` if the endpoint is missing / unreachable / malformed.
 *
 * `identity` is synthesised from the response's `oracle` (defaulting to
 * `"mawjs"` per ADR family-default) + `node` fields. Both fields must be
 * non-empty strings for `identity` to be returned — a peer that reports
 * neither is treated as legacy and skipped by the dedup check upstream.
 */
async function fetchPeerIdentityFields(
  url: string,
  timeoutMs: number,
): Promise<{ pubkey?: string; identity?: { oracle: string; node: string } } | undefined> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(new URL("/api/identity", url), { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return undefined;
    const body = (await res.json()) as { pubkey?: unknown; oracle?: unknown; node?: unknown };
    const out: { pubkey?: string; identity?: { oracle: string; node: string } } = {};
    if (typeof body.pubkey === "string" && body.pubkey.length > 0) out.pubkey = body.pubkey;
    const node = typeof body.node === "string" && body.node.length > 0 ? body.node : undefined;
    const oracle = typeof body.oracle === "string" && body.oracle.length > 0 ? body.oracle : "mawjs";
    if (node) out.identity = { oracle, node };
    return out;
  } catch {
    // Pre-Step-1 peers: no /api/identity yet. Step 4 will reject this — for
    // now (alpha migration window) we silently accept.
  }
  return undefined;
}

/**
 * Handshake gate — accepts the pre-#628 `maw: true` form AND the new
 * `maw: { schema: "1", ... }` form. Objects must carry at least a
 * `schema` string to count as a valid new-shape handshake (bare `{}`
 * is rejected so a typo doesn't silently pass). Anything truthy but
 * not one of these shapes (e.g. `maw: "yes"`, `maw: 1`) is rejected —
 * future shapes should bump the schema field rather than changing the
 * outer type.
 */
export function isValidMawHandshake(maw: unknown): boolean {
  if (maw === true) return true;
  if (maw && typeof maw === "object") {
    const m = maw as { schema?: unknown };
    return typeof m.schema === "string" && m.schema.length > 0;
  }
  return false;
}

/** Hint chooser — DNS bucket sub-types for ENOTIMP get a distinct hint (#593). */
export function pickHint(err: LastError): string {
  if (err.code === "DNS" && /ENOTIMP/i.test(err.message)) {
    return "install avahi-daemon (Linux) for mDNS, or add white.local to /etc/hosts";
  }
  return PROBE_HINTS[err.code] ?? PROBE_HINTS.UNKNOWN;
}

/** Colored, multi-line stderr block with actionable hint. */
export function formatProbeError(err: LastError, url: string, alias: string): string {
  const hint = pickHint(err);
  const host = safeHost(url);
  return [
    `\x1b[33m⚠\x1b[0m peer handshake failed: \x1b[1m${err.code}\x1b[0m`,
    `   host: ${host}`,
    `   error: ${err.message}`,
    `   hint: ${hint}`,
    `   retry: maw peers probe ${alias}`,
  ].join("\n");
}

function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}
