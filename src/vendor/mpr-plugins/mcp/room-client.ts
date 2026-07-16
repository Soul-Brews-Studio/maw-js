/**
 * room-client.ts — thin HTTP wrapper for the 5 room MCP tools.
 *
 * Each function maps one MCP tool call to one local-server HTTP request.
 * All HTTP logic is injectable (RoomClientDeps) so tests run without a live server.
 * No maw-js/core or CLI imports — only maw-js/sdk (boundary #2113).
 */
import { loadConfig, type MawConfig } from "maw-js/sdk";

export interface RoomHttpResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface RoomClientDeps {
  /** Returns the local server base URL (e.g. http://127.0.0.1:3456). */
  localBaseUrl: () => string;
  /** Injectable fetch — tests replace with a mock. */
  fetch: (url: string, init?: RequestInit) => Promise<RoomHttpResponse>;
}

function defaultLocalBaseUrl(config: MawConfig = loadConfig()): string {
  return `http://127.0.0.1:${config.port}`;
}

async function defaultFetch(url: string, init?: RequestInit): Promise<RoomHttpResponse> {
  const res = await globalThis.fetch(url, init);
  let body: unknown;
  try { body = await res.json(); } catch { body = {}; }
  return { ok: res.ok, status: res.status, body };
}

export function defaultRoomClientDeps(): RoomClientDeps {
  return { localBaseUrl: defaultLocalBaseUrl, fetch: defaultFetch };
}

function toText(response: RoomHttpResponse): string {
  if (response.ok) return JSON.stringify(response.body);
  const err = (response.body as Record<string, unknown>)?.error ?? `HTTP ${response.status}`;
  return `room error: ${err}`;
}

// ── 5 room operations ─────────────────────────────────────────────────────────

/**
 * GET /api/room/thread — read the persisted thread for a room.
 * Returns the room artifact (messages[], topic, status, …).
 */
export async function roomRead(
  params: { company: string; room: string; last?: number; since?: number | string; all?: boolean },
  deps: RoomClientDeps = defaultRoomClientDeps(),
): Promise<{ ok: boolean; text: string }> {
  const base = deps.localBaseUrl();
  // kobo-322: default-capped to the last 20 turns server-side; last/since/all page it.
  let url = `${base}/api/room/thread?company=${encodeURIComponent(params.company)}&room=${encodeURIComponent(params.room)}`;
  if (params.last !== undefined) url += `&last=${encodeURIComponent(String(params.last))}`;
  if (params.since !== undefined) url += `&since=${encodeURIComponent(String(params.since))}`;
  if (params.all) url += `&all=1`;
  const res = await deps.fetch(url);
  return { ok: res.ok, text: toText(res) };
}

/**
 * POST /api/room/reply — oracle replies into the room artifact.
 * `from` must be a verified room oracle (Rule-6 enforced server-side).
 */
export async function roomReply(
  params: { company: string; room: string; from: string; text: string },
  deps: RoomClientDeps = defaultRoomClientDeps(),
): Promise<{ ok: boolean; text: string }> {
  const base = deps.localBaseUrl();
  const res = await deps.fetch(`${base}/api/room/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return { ok: res.ok, text: toText(res) };
}

/**
 * POST /api/room/merge — consolidate source rooms into target.
 * `confirm` is always true here — the act of calling this MCP tool IS the confirmation.
 */
export async function roomMerge(
  params: { company: string; target: string; sources: string[] },
  deps: RoomClientDeps = defaultRoomClientDeps(),
): Promise<{ ok: boolean; text: string }> {
  const base = deps.localBaseUrl();
  const res = await deps.fetch(`${base}/api/room/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, confirm: true }),
  });
  return { ok: res.ok, text: toText(res) };
}

/**
 * POST /api/room/close — close a room (thread preserved).
 */
export async function roomClose(
  params: { company: string; room: string },
  deps: RoomClientDeps = defaultRoomClientDeps(),
): Promise<{ ok: boolean; text: string }> {
  const base = deps.localBaseUrl();
  const res = await deps.fetch(`${base}/api/room/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return { ok: res.ok, text: toText(res) };
}

/**
 * POST /api/room/open — create or reopen a room (idempotent).
 */
export async function roomOpen(
  params: { company: string; room: string; topic?: string },
  deps: RoomClientDeps = defaultRoomClientDeps(),
): Promise<{ ok: boolean; text: string }> {
  const base = deps.localBaseUrl();
  const res = await deps.fetch(`${base}/api/room/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return { ok: res.ok, text: toText(res) };
}
