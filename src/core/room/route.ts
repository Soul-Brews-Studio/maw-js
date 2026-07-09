/**
 * Brainstorm Room — core wire (kobo-245, slice 1).
 *
 * A "room" is NOT new infra: it's a `[room:<id>]` tag riding the EXISTING hey
 * transport. The web input box POSTs here; we deliver the message to the lead pane
 * with `maw hey` — the same primitive every oracle uses. That hey emits a
 * `MessageSend` feed event (buildMessageLifecycleFeedEvent), so the message shows up
 * on the public `/api/feed` with NO extra write. The lead replies with its own
 * `[room:<id>]`-tagged hey → another feed event → the web renders both sides by
 * filtering `/api/feed` on the room tag. Round-trip = hey + feed, zero new transport.
 *
 * kobo-241 (slice 2): the room is now a persisted OFF-CARD artifact
 * (rooms/<id>.json). open/close/reopen + the thread render read/write that artifact;
 * turns land in it via the room feed listener. Out of scope (later): attribution (3),
 * merge (4), distill-to-card (5).
 */

import { openRoom, closeRoom, reopenRoom, readRoom, listRooms, linkRoomCard, mergeRooms, findRoomCompany, appendRoomMessage } from "./store";
import { addTask, readTask } from "../tasks/store";
import { roomActivity } from "./activity";
import { readWorklog } from "../worklog/store";
import { readPresenceRows } from "../presence/route";

/** The tag that scopes a message to a room (both directions carry it). */
export function roomTag(room: string): string {
  return `[room:${room}]`;
}

/** True when a feed message/text belongs to this room (client + server share this). */
export function messageInRoom(text: string | undefined, room: string): boolean {
  return !!text && text.includes(roomTag(room));
}

/**
 * The web author's hey identity (kobo-248). Without `--from`, the hey inherits the
 * SERVER-host oracle (e.g. m5:eq3), so Tony's web turns get attributed to the lead and
 * become indistinguishable in the thread. We stamp a `web:<name>` sender instead — the
 * `web` node marks the human side, so roomActivity (which excludes bare-name "web")
 * drops it from the teammate list. Sanitized to the sender-part charset hey accepts.
 */
export function roomSender(from: string | undefined): string {
  const name = (from || "web").replace(/[^A-Za-z0-9_.-]/g, "") || "web";
  return `web:${name}`;
}

/** The `maw hey` argv that delivers a room message to the lead (reuses hey 100%). The
 *  web turn is stamped `--from web:<author>` so it isn't attributed to the host oracle. */
export function roomSendArgs(room: string, to: string, text: string, from = "web"): string[] {
  return ["hey", "--from", roomSender(from), to, `${roomTag(room)} ${text}`];
}

export type SpawnFn = (argv: string[]) => { exited: Promise<number> };

const defaultSpawn: SpawnFn = (argv) => Bun.spawn(["maw", ...argv], { stdout: "ignore", stderr: "ignore" });

/**
 * POST /api/room/send — body { room, to, text, from } → persist the outbound turn to the
 * artifact SYNCHRONOUSLY (kobo-249: the artifact is the source of truth, so a turn lands
 * within <2s of send regardless of whether the lead pane is busy), THEN deliver via
 * `maw hey` (same path a human `maw hey` takes). The turn's own delivery feed event still
 * fires later — idle-gated, lagging under load — but appendRoomMessage dedups it against
 * this send-time write. The lead's reply still persists on its own feed event (slice-1
 * round-trip intact). The persisted `from` is roomSender(from) — the SAME `web:<author>`
 * identity the spawned hey stamps via `--from` (kobo-248), so the two writes agree and
 * dedup. `spawn` is injectable for unit tests.
 */
export async function handleRoomSendRequest(request: Request, spawn: SpawnFn = defaultSpawn): Promise<Response> {
  let body: { room?: unknown; to?: unknown; text?: unknown; from?: unknown };
  try {
    body = (await request.json()) as { room?: unknown; to?: unknown; text?: unknown; from?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const room = typeof body.room === "string" ? body.room.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : "web"; // the web author (kobo-248)
  if (!room || !to || !text) {
    return Response.json({ ok: false, error: "room, to and text are required" }, { status: 400 });
  }
  try {
    // kobo-249 — persist the outbound turn NOW (source of truth), decoupled from the
    // idle-gated delivery feed event. Only an OPEN room has an artifact; findRoomCompany
    // returns null otherwise (a send to an unopened room delivers but persists nothing,
    // same as before). Persist under the SAME web:<author> identity the hey stamps
    // (roomSender), so the turn's own lagging feed event dedups against this write.
    const company = findRoomCompany(room);
    if (company) {
      const author = roomSender(from);
      appendRoomMessage(company, room, { id: `send-${author}-${Date.now()}`, from: author, text, ts: Date.now() });
    }
    const proc = spawn(roomSendArgs(room, to, text, from));
    // Best-effort delivery: don't block the response on it. Persistence already happened
    // above, so a busy pane no longer lags the thread (kobo-240 spike / finding #3).
    void proc.exited;
    return Response.json({ ok: true, room, to });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "send failed" }, { status: 500 });
  }
}

// ── kobo-241 slice 2: off-card room-artifact lifecycle + thread read ──────────

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try { return (await request.json()) as Record<string, unknown>; } catch { return null; }
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * POST /api/room/open — body { company, room, topic } → create/reopen the off-card
 * artifact rooms/<id>.json (idempotent; a reopen keeps the thread). Returns the room.
 */
export async function handleRoomOpenRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room), topic = str(body.topic);
  if (!company || !room) return Response.json({ ok: false, error: "company and room are required" }, { status: 400 });
  return Response.json({ ok: true, room: openRoom(company, room, topic) });
}

/** POST /api/room/close — { company, room } → status→closed (thread preserved). */
export async function handleRoomCloseRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room);
  if (!company || !room) return Response.json({ ok: false, error: "company and room are required" }, { status: 400 });
  const r = closeRoom(company, room);
  if (!r) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });
  return Response.json({ ok: true, room: r });
}

/** POST /api/room/reopen — { company, room } → status→open (thread preserved). */
export async function handleRoomReopenRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room);
  if (!company || !room) return Response.json({ ok: false, error: "company and room are required" }, { status: 400 });
  const r = reopenRoom(company, room);
  if (!r) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });
  return Response.json({ ok: true, room: r });
}

/**
 * POST /api/room/merge — { company, target, sources:[], confirm:true } → consolidate the
 * source rooms INTO the target (kobo-243, lead-proposed merge of same-problem rooms). The
 * `confirm` flag is the GATE: without confirm===true it 400s — a merge is NEVER automatic
 * (the lead proposes, a human confirms, only then does it run). Sources are archived
 * (status→"merged", linked via mergedInto), never deleted. Returns the merged target.
 */
export async function handleRoomMergeRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), target = str(body.target);
  const sources = Array.isArray(body.sources) ? body.sources.map(str).filter(Boolean) : [];
  if (!company || !target || !sources.length) {
    return Response.json({ ok: false, error: "company, target and at least one source are required" }, { status: 400 });
  }
  if (body.confirm !== true) {
    return Response.json({ ok: false, error: "merge requires confirm:true (never auto-merge — lead proposes, human confirms)" }, { status: 400 });
  }
  const r = mergeRooms(company, target, sources);
  if (!r) return Response.json({ ok: false, error: `target room not found: ${target}` }, { status: 404 });
  return Response.json({ ok: true, room: r });
}

/**
 * GET /api/room/thread?company=<c>&room=<id> — the persisted thread for the /room web
 * view (durable, so a reopen reloads the full conversation). Omit `room` → the room
 * list for the picker. Read-only.
 */
export function handleRoomThreadRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = (url.searchParams.get("company") ?? "").trim();
  const room = (url.searchParams.get("room") ?? "").trim();
  if (!company) return Response.json({ ok: false, error: "company is required" }, { status: 400 });
  if (!room) return Response.json({ ok: true, rooms: listRooms(company).map((r) => ({ id: r.id, topic: r.topic, status: r.status, updatedTs: r.updatedTs })) });
  const r = readRoom(company, room);
  if (!r) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });
  return Response.json({ ok: true, room: r });
}

// ── kobo-244 slice 5: distill room-artifact → kanban card (the ONE room→board touch) ──

/**
 * POST /api/room/distill — body { company, room, title, body?, assignee?, reviewer? }
 * → promote a room's grounding conversation into a board card. The caller supplies the
 * DISTILLED problem+approach (title + optional body); this handler only does the
 * promote + link mechanics, REUSING the card-create path (addTask — no new card system).
 * Writes a bidirectional link: the card carries room=<id> (provenance), the artifact
 * records cardId=<card>. Idempotent — a room already distilled returns its existing card
 * (no duplicate) so a double-click can't mint two cards for one room.
 */
export async function handleRoomDistillRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room), title = str(body.title);
  if (!company || !room || !title) {
    return Response.json({ ok: false, error: "company, room and title are required" }, { status: 400 });
  }
  const artifact = readRoom(company, room);
  if (!artifact) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });

  // Already distilled → return the existing card (dedup). If the recorded card was
  // deleted the link is stale, so fall through and mint a fresh one.
  if (artifact.cardId) {
    const existing = readTask(company, artifact.cardId);
    if (existing) return Response.json({ ok: true, card: existing, room: artifact, deduped: true });
  }

  const detail = str(body.body);
  const assignee = str(body.assignee) || undefined;
  const reviewer = str(body.reviewer) || undefined;
  const card = addTask({ company, title, by: "tony", room, ...(detail ? { body: detail } : {}), ...(assignee ? { assignee } : {}), ...(reviewer ? { reviewer } : {}) });
  const linked = linkRoomCard(company, room, card.id) ?? artifact;
  return Response.json({ ok: true, card, room: linked });
}

/**
 * GET /api/room/activity?company=<c>&room=<id> — CC-style "who's doing what" for the
 * room's participants (kobo-242, slice 3). A pure projection: participants from the
 * artifact, "doing X" from the worklog feed, busy/ctx from presence — reuses all three
 * readers, no new store. Read-only.
 */
export function handleRoomActivityRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = (url.searchParams.get("company") ?? "").trim();
  const room = (url.searchParams.get("room") ?? "").trim();
  if (!company || !room) return Response.json({ ok: false, error: "company and room are required" }, { status: 400 });
  const r = readRoom(company, room);
  if (!r) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });
  return Response.json({ ok: true, participants: roomActivity(r, readWorklog(company, { limit: 200 }), readPresenceRows(Date.now())) });
}
