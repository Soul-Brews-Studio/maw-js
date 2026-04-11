/**
 * curlFetch — HTTP for federation calls.
 *
 * Uses native fetch() by default (faster, no subprocess).
 * Falls back to curl subprocess on macOS for local/WireGuard IPs
 * (Apple's Local Network Privacy blocks Bun/Node fetch).
 *
 * Auto-signs requests with HMAC-SHA256 when federationToken is configured.
 */

import { signHeaders } from "./lib/federation-auth";
import { loadConfig } from "./config";

const IS_MACOS = process.platform === "darwin";

export interface CurlResponse {
  ok: boolean;
  status: number;
  data: any;
}

export async function curlFetch(url: string, opts?: {
  method?: string;
  body?: string;
  timeout?: number;
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
  } catch {}

  // Prefer native fetch (Linux, remote hosts)
  // Fall back to curl on macOS (Local Network Privacy blocks fetch for LAN/WG)
  if (!IS_MACOS) {
    return nativeFetch(url, opts, headers);
  }
  return curlSpawn(url, opts, headers);
}

async function nativeFetch(url: string, opts: typeof curlFetch extends (u: string, o?: infer O) => any ? O : never, headers: Record<string, string>): Promise<CurlResponse> {
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
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function curlSpawn(url: string, opts: typeof curlFetch extends (u: string, o?: infer O) => any ? O : never, headers: Record<string, string>): Promise<CurlResponse> {
  const timeoutSec = Math.ceil((opts?.timeout || 10000) / 1000);
  const args = ["curl", "-sf", "--max-time", String(timeoutSec)];
  if (opts?.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (opts?.body) args.push("-d", opts.body);
  args.push(url);

  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return { ok: false, status: code, data: null };
    return { ok: true, status: 200, data: text ? JSON.parse(text) : null };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
