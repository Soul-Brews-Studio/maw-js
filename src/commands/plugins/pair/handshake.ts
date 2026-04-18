/**
 * Pair handshake HTTP client — acceptor side (#573).
 * No HMAC here — the code itself authenticates this single exchange.
 */

export interface HandshakeRequest { node: string; url: string }
export interface HandshakeSuccess { ok: true; node: string; url: string; federationToken: string }
export interface HandshakeFailure { ok: false; error: string; status: number }
export type HandshakeResult = HandshakeSuccess | HandshakeFailure;

/** POST <baseUrl>/api/pair/<code> with acceptor identity. */
export async function postHandshake(
  baseUrl: string,
  code: string,
  body: HandshakeRequest,
  timeoutMs = 5000,
): Promise<HandshakeResult> {
  const url = new URL(`/api/pair/${encodeURIComponent(code)}`, baseUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && j.ok) {
      return { ok: true, node: String(j.node ?? ""), url: String(j.url ?? ""), federationToken: String(j.federationToken ?? "") };
    }
    return { ok: false, error: String(j.error ?? res.statusText ?? "unknown"), status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : (e?.message ?? "network_error"), status: 0 };
  } finally {
    clearTimeout(t);
  }
}

/** Warn if handshake targets plain-HTTP over non-loopback. */
export function warnIfPlainHttp(targetUrl: string): void {
  try {
    const u = new URL(targetUrl);
    const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    if (u.protocol === "http:" && !isLoopback) {
      console.warn("⚠ pairing over plain HTTP — TLS recommended for cross-network pairing");
    }
  } catch { /* bad URL — fetch will surface */ }
}
