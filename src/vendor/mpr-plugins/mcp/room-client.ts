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
  params: { company: string; room: string; last?: number; since?: number | string; all?: boolean; offset?: number },
  deps: RoomClientDeps = defaultRoomClientDeps(),
): Promise<{ ok: boolean; text: string }> {
  const base = deps.localBaseUrl();
  // kobo-322: default-capped to the last 20 turns server-side; last/since/all page it.
  // kobo-357: offset pages further back (skip N from the tail before taking `last`).
  let url = `${base}/api/room/thread?company=${encodeURIComponent(params.company)}&room=${encodeURIComponent(params.room)}`;
  if (params.last !== undefined) url += `&last=${encodeURIComponent(String(params.last))}`;
  if (params.since !== undefined) url += `&since=${encodeURIComponent(String(params.since))}`;
  if (params.all) url += `&all=1`;
  if (params.offset !== undefined) url += `&offset=${encodeURIComponent(String(params.offset))}`;
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
  if (!res.ok) return { ok: false, text: toText(res) }; // already compact — no full-room dump on error
  // kobo-360: the endpoint echoes the FULL room artifact (every message) on success —
  // fine for the web UI, but a token-waste for an MCP caller who only needs "did it land".
  // Client-side trim ONLY (the endpoint itself is unchanged — other consumers still get
  // the full room). Return a compact ack: the just-appended reply's id+ts (it's always
  // the newest message — appendRoomMessage pushes to the end).
  const body = res.body as { room?: { messages?: Array<{ id: string; ts: number }> } };
  const last = body.room?.messages?.at(-1);
  return { ok: true, text: JSON.stringify(last ? { ok: true, id: last.id, ts: last.ts } : { ok: true }) };
}

/**
 * kobo-368 — compact-ack shape for open/close/merge, mirroring roomReply's
 * kobo-360 fix exactly: trim the room artifact echo down to the handful of
 * fields a caller actually needs to confirm the op landed. COMPACT-ALWAYS
 * (no --verbose/--full escape hatch) — this mirrors roomReply's own
 * precedent, not the CLI verb sweep's opt-in pattern: MCP tool calls have no
 * argv flag surface, and the full room is separately reachable via
 * `maw_room_read` for any caller who genuinely needs it. Client-side trim
 * ONLY — the server endpoints are UNCHANGED (other consumers, e.g. the web
 * UI, still get the full room).
 */
function compactRoomAck(body: unknown): string {
  const room = (body as { room?: { id?: string; status?: string; ts?: number; updatedTs?: number; messages?: unknown[]; mergedFrom?: string[] } })?.room;
  if (!room) return JSON.stringify({ ok: true });
  return JSON.stringify({
    ok: true,
    id: room.id,
    status: room.status,
    updatedTs: room.updatedTs,
    messageCount: room.messages?.length ?? 0,
    ...(room.mergedFrom ? { mergedFrom: room.mergedFrom } : {}),
  });
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
  if (!res.ok) return { ok: false, text: toText(res) }; // already compact — no full-room dump on error
  return { ok: true, text: compactRoomAck(res.body) };
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
  if (!res.ok) return { ok: false, text: toText(res) };
  return { ok: true, text: compactRoomAck(res.body) };
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
  if (!res.ok) return { ok: false, text: toText(res) };
  return { ok: true, text: compactRoomAck(res.body) };
}
