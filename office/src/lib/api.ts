/**
 * Centralized API host resolution — local.drizzle.studio pattern.
 *
 * When loaded from CF (local.buildwithoracle.com), user passes ?host=white.local:3456
 * Server auto-detects mkcert and serves HTTPS (same as drizzle-kit).
 * When loaded locally (same origin), uses relative paths.
 */

const params = new URLSearchParams(window.location.search);
const hostParam = params.get("host"); // e.g. "white.local:3456"

/** Whether we're running in remote mode */
export const isRemote = !!hostParam;

/** Build full URL for fetch() calls */
export function apiUrl(path: string): string {
  if (!hostParam) return path;
  return `https://${hostParam}${path}`;
}

/** WebSocket URL */
export function wsUrl(path: string): string {
  if (!hostParam) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${path}`;
  }
  return `wss://${hostParam}${path}`;
}
