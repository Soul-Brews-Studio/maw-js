/**
 * maw peers — handshake probe + error classifier (#565).
 *
 * Replaces the silent try/catch→null in resolveNode(). probePeer()
 * fetches `<url>/info`, classifies failures into a small enum, and
 * returns both the resolved node (if any) and a structured error (if
 * any). Callers decide whether to persist, warn, or retry.
 *
 * The old resolveNode() wrapper in impl.ts still returns `string | null`
 * for call sites that only want the node — no silent reroute.
 */
import type { LastError } from "./store";

export type ProbeErrorCode = LastError["code"];

export interface ProbeResult {
  /** Resolved node name from /info, or null on any failure or missing field. */
  node: string | null;
  /** Structured error if the probe failed; undefined on success. */
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
 *
 * Node/undici surfaces syscall codes via `err.cause.code` for fetch failures.
 * AbortError names an abort (our 2s timeout). TLS failures surface as
 * CERT_* / SELF_SIGNED_* codes. HTTP failures come in as a non-ok Response.
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
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS";
  if (code === "ECONNREFUSED") return "REFUSED";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "TIMEOUT";
  if (err.name === "AbortError" || err.name === "TimeoutError") return "TIMEOUT";
  if (typeof code === "string" && (code.startsWith("CERT_") || code.startsWith("SELF_SIGNED") || code.startsWith("DEPTH_ZERO_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
    return "TLS";
  }

  return "UNKNOWN";
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
 * Probe a peer's /info endpoint with a 2s timeout.
 *
 * On success: { node: <string|null> } — node field comes from body.node
 * or body.name. Missing both => node=null with BAD_BODY error recorded.
 *
 * On failure: { node: null, error: {...} } — caller persists lastError
 * and prints a loud warning.
 */
export async function probePeer(url: string, timeoutMs = 2000): Promise<ProbeResult> {
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

/**
 * Format a probe error as a colored, multi-line stderr block with hint.
 * Stderr-only so piping stdout to jq is safe.
 */
export function formatProbeError(err: LastError, url: string, alias: string): string {
  const hint = PROBE_HINTS[err.code] ?? PROBE_HINTS.UNKNOWN;
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
