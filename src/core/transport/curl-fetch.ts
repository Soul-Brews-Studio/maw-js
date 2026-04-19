/**
 * curlFetch — HTTP for federation calls.
 *
 * Uses native fetch() by default (faster, no subprocess).
 * Falls back to curl subprocess on macOS for local/WireGuard IPs
 * (Apple's Local Network Privacy blocks Bun/Node fetch).
 *
 * Auto-signs requests with HMAC-SHA256 when federationToken is configured.
 */

import { signHeaders } from "../../lib/federation-auth";
import { loadConfig } from "../../config";

const IS_MACOS = process.platform === "darwin";

// #653: cap response body to defend against a hostile peer returning an
// unbounded stream. 10 MB matches the project convention for untrusted
// HTTP bodies (see plugin-install tarball cap). Callers can override via
// opts.maxBytes when a larger ceiling is genuinely needed.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface CurlResponse {
  ok: boolean;
  status: number;
  data: any;
}

export async function curlFetch(url: string, opts?: {
  method?: string;
  body?: string;
  timeout?: number;
  maxBytes?: number;
}): Promise<CurlResponse> {
  // Build auth headers
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  try {
    const token = loadConfig().federationToken;
    if (token) {
      const urlObj = new URL(url);
      const signed = signHeaders(token, opts?.method || "GET", urlObj.pathname);
      Object.assign(headers, signed);
    }
  } catch (err) {
    // Fail closed: if a token is configured but signing throws (config load
    // failure, malformed URL, etc.), do NOT fall through to an unsigned
    // request — peers would reject with a bare 401 and the user would see
    // no diagnosis. Surface the signing failure and abort the call.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[curl-fetch] signing failed for ${url}: ${msg}`);
    return { ok: false, status: 0, data: null };
  }

  // Prefer native fetch (Linux, remote hosts)
  // Fall back to curl on macOS (Local Network Privacy blocks fetch for LAN/WG)
  if (!IS_MACOS) {
    return nativeFetch(url, opts, headers);
  }
  return curlSpawn(url, opts, headers);
}

async function nativeFetch(url: string, opts: typeof curlFetch extends (u: string, o?: infer O) => any ? O : never, headers: Record<string, string>): Promise<CurlResponse> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeout || 10000);
    const res = await fetch(url, {
      method: opts?.method || "GET",
      headers,
      body: opts?.body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // #653: reject before buffering if the peer declares an oversized body.
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      controller.abort();
      return { ok: false, status: res.status, data: { error: `body exceeded ${maxBytes} bytes` } };
    }

    // Stream-read with a running byte cap — Content-Length can be absent or
    // spoofed, so we must enforce during the read, not only up front.
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: res.ok, status: res.status, data: null };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        controller.abort();
        return { ok: false, status: res.status, data: { error: `body exceeded ${maxBytes} bytes` } };
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const text = new TextDecoder().decode(buf);
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // Surface the failure (#385 site 1). Previously this catch swallowed
    // every error — abort, JSON parse, network, DNS — and callers saw a
    // bare {ok:false, status:0} with no diagnosis. We keep the return
    // shape (22 callers depend on it) and warn loud before returning.
    // Note: signing failures return early at the catch above, so this
    // path never fires for signing errors — no duplicate output.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`\x1b[33m⚠\x1b[0m nativeFetch failed: ${opts?.method ?? "GET"} ${url} — ${msg}`);
    return { ok: false, status: 0, data: null };
  }
}

async function curlSpawn(url: string, opts: typeof curlFetch extends (u: string, o?: infer O) => any ? O : never, headers: Record<string, string>): Promise<CurlResponse> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutSec = Math.ceil((opts?.timeout || 10000) / 1000);
  // curl --max-filesize refuses the transfer if Content-Length exceeds the
  // cap; we still track bytes on the pipe because the header can be missing.
  const args = ["curl", "-sf", "--max-time", String(timeoutSec), "--max-filesize", String(maxBytes)];
  if (opts?.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (opts?.body) args.push("-d", opts.body);
  args.push(url);

  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exceeded = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        try { await reader.cancel(); } catch { /* best effort */ }
        try { proc.kill(); } catch { /* best effort */ }
        break;
      }
      chunks.push(value);
    }
    const code = await proc.exited;
    if (exceeded) {
      return { ok: false, status: 0, data: { error: `body exceeded ${maxBytes} bytes` } };
    }
    if (code !== 0) return { ok: false, status: code, data: null };
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const text = new TextDecoder().decode(buf);
    return { ok: true, status: 200, data: text ? JSON.parse(text) : null };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
