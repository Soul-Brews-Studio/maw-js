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
  error?: LastError;
}

/** Actionable hint per error code — shown in CLI output. */
export const PROBE_HINTS: Record<ProbeErrorCode, string> = {
  DNS: "Host does not resolve. Check /etc/hosts, DNS, or VPN.",
  REFUSED: "Host resolves but port is closed. Is the peer process running?",
  TIMEOUT: "Peer did not respond within 2s. Network path may be blocked.",
  TLS: "TLS handshake failed. Check cert validity / chain.",
  HTTP_4XX: "Peer responded with a client error. /info endpoint may be missing.",
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

  let body: { node?: unknown; name?: unknown };
  try {
    body = await res.json() as { node?: unknown; name?: unknown };
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

  return { node };
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
