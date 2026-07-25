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

import { openRoom, closeRoom, reopenRoom, readRoom, listRooms, linkRoomCard, mergeRooms, findRoomCompany, appendRoomMessage, addRoomParticipant, paginateRoomMessages, type RoomPageOpts, type RoomArtifact } from "./store";
import { addTask, readTask } from "../tasks/store";
import { roomActivity, bareName } from "./activity";
import { readWorklog } from "../worklog/store";
import { readPresenceRows } from "../presence/route";
import { listCompanies, companyExists, companyLead, companyOracles } from "../../vendor/mpr-plugins/company/company-helpers";

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

/**
 * The `maw hey` argv that NUDGES the lead about a new room turn (kobo-260). It is
 * deliberately PLAIN / UNTAGGED — no `[room:<id>]` — so the room feed listener does NOT
 * re-capture it (that re-capture was the finding-#4 self-echo). The turn itself is already
 * persisted to the artifact at send time (kobo-249); this hey only tells the lead to go
 * look + reply via /api/room/reply. Still stamped `--from web:<author>` so the nudge isn't
 * attributed to the host oracle.
 */
export function roomNudgeArgs(room: string, to: string, from = "web"): string[] {
  // kobo-306 — --queue-on-away: if the lead pane is away (sticky, kobo-287), queue the
  // nudge for auto-delivery when they /seat back instead of dropping it to a silent (and
  // sometimes failing) inbox. A brainstorm turn is informational + the human is at the web,
  // so an away lead must still learn of it on return (kobo-305 root cause).
  return ["hey", "--from", roomSender(from), "--queue-on-away", to, `💬 new turn in room "${room}" — open the brainstorm room to reply`];
}

export type SpawnFn = (argv: string[]) => { exited: Promise<number> };

const defaultSpawn: SpawnFn = (argv) => Bun.spawn(["maw", ...argv], { stdout: "ignore", stderr: "ignore" });

// kobo-385: @handle-in-text → hey-target override. Word-anchored so `a@b.com` / mid-word `@`
// never match. Hard-deny is caller-independent (roomRepliers harvests every `m.from` that has
// spoken, so a caller POSTing `from:"tony"` would otherwise seed "tony" into the set) — checked
// BEFORE membership, so it can't be bypassed by planting a speaker.
const ROOM_TAG_RE = /(?:^|\s)@([a-z0-9][a-z0-9_.-]*)/i;
const ROOM_TAG_DENY = new Set(["web", "tony", "human"]);

/** First valid @handle in `text`, or null (falls back to the incoming `to` = lead). */
function resolveRoomTag(text: string, company: string | null, artifact: RoomArtifact | null): string | null {
  if (!company || !artifact) return null;
  const m = text.match(ROOM_TAG_RE);
  if (!m) return null;
  const handle = bareName(m[1]);
  if (ROOM_TAG_DENY.has(handle)) return null;
  return roomRepliers(company, artifact).has(handle) ? handle : null;
}

/**
 * POST /api/room/send — body { room, to, text, from } → persist the outbound turn to the
 * artifact SYNCHRONOUSLY (kobo-249: the artifact is the source of truth, so a turn lands
 * within <2s of send regardless of whether the lead pane is busy), THEN deliver via
 * `maw hey` (same path a human `maw hey` takes). The turn's own delivery feed event never
 * re-persists it — the nudge hey is deliberately untagged (kobo-260 finding #4), so the
 * feed listener's `[room:<id>]` capture is a no-op for it; this send-time write is the
 * ONLY write. The persisted `from` is always the constant `"web"` (kobo-386) — NEVER
 * `roomSender(from)`/the caller-supplied name, which is untrusted (nothing in the request
 * path verifies it; a raw POST could pick any string and have it render as an impersonated
 * teammate). The typed name still reaches the outbound hey's `--from` stamp for notification
 * cosmetics only. `spawn` is injectable for unit tests.
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
  const company = findRoomCompany(room);
  // Rule-6 (kobo-260): the web/human side may NOT impersonate a company oracle — reject the
  // whole request if the caller-supplied name collides with a real teammate name (defense in
  // depth for the outbound hey's --from stamp, which still carries the user-typed name).
  const author = bareName(roomSender(from));
  if (company && companyOracles(company).has(author)) {
    return Response.json({ ok: false, error: `"${author}" is a company oracle — the web side can't send as a teammate` }, { status: 403 });
  }
  // kobo-296: enforce room write-gate — closed/merged rooms reject all replies (not persisted, not nudged)
  // kobo-385: hoisted out of the if-block — resolveRoomTag needs the artifact for roomRepliers.
  const artifact = company ? readRoom(company, room) : null;
  if (artifact && artifact.status !== "open") {
    return Response.json({ ok: false, error: `room "${room}" is ${artifact.status} — replies are not accepted` }, { status: 403 });
  }
  try {
    // kobo-249 — persist the outbound turn NOW (source of truth), decoupled from delivery.
    // Only an OPEN room has an artifact (findRoomCompany null → deliver but persist nothing).
    // kobo-260/386: the PERSISTED identity is always the constant "web" — never the
    // caller-supplied name. `author` (derived from client-supplied `from`) is NOT trustworthy
    // as an identity (kobo-386: nothing in the request path verifies it — a raw POST with any
    // `from` string was rendering as an impersonated teammate). The typed name still reaches
    // the outbound hey's --from stamp (line below) for notification cosmetics only; it never
    // becomes the room artifact's speaker of record.
    if (company) {
      appendRoomMessage(company, room, { id: `send-web-${Date.now()}`, from: "web", text, ts: Date.now() });
    }
    // kobo-385: @handle in the text overrides the hey target; unmatched/denied → falls back
    // to the incoming `to` (the web's default = lead). Response surfaces the RESOLVED target.
    let target = resolveRoomTag(text, company, artifact) ?? to;
    // kobo-385 (2nd request-change): the base `to` is ALSO caller-settable (raw POST, no
    // @tag) — guard the value that actually reaches roomNudgeArgs, not just the tag-handle
    // path. The deny itself is COMPANY-INDEPENDENT (an unknown/never-opened `room` makes
    // `company` null under caller control — gating the deny on `company` was itself the
    // bypass: {room:"does-not-exist", to:"tony"} skipped it entirely). Only the *fallback*
    // needs a company (to resolve a lead); with none, drop the nudge rather than ever spawn
    // a denied literal.
    if (ROOM_TAG_DENY.has(bareName(target))) {
      if (!company) return Response.json({ ok: true, room, to: null, skipped: true });
      target = companyLead(company);
    }
    // kobo-260: nudge the lead with a PLAIN/UNTAGGED hey (no [room:<id>]) → the listener
    // does NOT re-capture it → no self-echo (finding #4 dissolves at the root; no dedup
    // needed). The turn is already persisted above; the lead replies via /api/room/reply.
    const proc = spawn(roomNudgeArgs(room, target, from));
    void proc.exited;
    return Response.json({ ok: true, room, to: target });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "send failed" }, { status: 500 });
  }
}

// ── kobo-241 slice 2: off-card room-artifact lifecycle + thread read ──────────

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try { return (await request.json()) as Record<string, unknown>; } catch { return null; }
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ── kobo-260: reply primitive + teammate invite ───────────────────────────────

/**
 * The oracles allowed to REPLY into a room (kobo-260 Rule-6 verify set): the company's own
 * oracles (lead + members) ∪ the explicitly invited teammates (may be cross-company, e.g. a
 * pgw reviewer pulled into a kobo room) ∪ anyone who has already spoken. Never the human
 * "web" side. A reply `from` outside this set is rejected — no impersonating a human/oracle.
 */
function roomRepliers(company: string, room: RoomArtifact): Set<string> {
  const s = companyOracles(company);
  for (const p of room.participants ?? []) s.add(bareName(p));
  for (const m of room.messages) { const n = bareName(m.from || ""); if (n) s.add(n); }
  s.delete("web");
  return s;
}

/**
 * POST /api/room/reply — body { company, room, from, text } → a teammate/lead replies
 * DIRECTLY into the room artifact (kobo-260). This is the room-target reply primitive that
 * replaces the "hey a hand-picked pane with a [room:] tag" hack (finding #5): the room is
 * the target, not a pane. Rule-6: `from` is server-verified against roomRepliers — it must
 * be a real oracle of the room, never the human "web" side (no impersonation). id/ts minted
 * server-side. No hey, no feed event — the web renders it on the next artifact poll.
 */
export async function handleRoomReplyRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room), text = str(body.text);
  const from = bareName(str(body.from));
  if (!company || !room || !from || !text) return Response.json({ ok: false, error: "company, room, from and text are required" }, { status: 400 });
  const r = readRoom(company, room);
  if (!r) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });
  if (r.status !== "open") {
    return Response.json({ ok: false, error: `room "${room}" is ${r.status} — replies are not accepted` }, { status: 403 });
  }
  if (from === "web" || !roomRepliers(company, r).has(from)) {
    return Response.json({ ok: false, error: `"${from}" may not reply here — reply must come from a room oracle (Rule 6: no impersonation)` }, { status: 403 });
  }
  const updated = appendRoomMessage(company, room, { id: `reply-${from}-${Date.now()}`, from, text, ts: Date.now() });
  return Response.json({ ok: true, room: updated });
}

/**
 * POST /api/room/invite — body { company, room, oracle } → explicitly pull a teammate into
 * the room (kobo-260). Records them on the artifact (they show in "who's here" before their
 * first turn) and sends exactly ONE hey — the model's only room-related hey — a plain notify
 * with a deep-link to the room. `oracle` may be cross-company (a reviewer from another
 * company is a valid pull-in). Their later turns attribute via the reply primitive. `spawn`
 * injectable for tests.
 */
export async function handleRoomInviteRequest(request: Request, spawn: SpawnFn = defaultSpawn): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room);
  const oracle = bareName(str(body.oracle));
  if (!company || !room || !oracle) return Response.json({ ok: false, error: "company, room and oracle are required" }, { status: 400 });
  // kobo-391: reuse ROOM_TAG_DENY (single-source with the @tag/`to` deny, kobo-385) instead of
  // a local partial check. The old `oracle === "web"` check let "tony"/"human" through — an
  // invited pseudo-identity lands in room.participants, which roomRepliers() unions into its
  // allowlist, so this gap let an invite poison /api/room/reply's allowlist too.
  if (ROOM_TAG_DENY.has(oracle)) return Response.json({ ok: false, error: `cannot invite "${oracle}" — not a real teammate identity` }, { status: 400 });
  const updated = addRoomParticipant(company, room, oracle);
  if (!updated) return Response.json({ ok: false, error: `room not found: ${room}` }, { status: 404 });
  // exactly one hey — a plain notify with a deep-link to the room web view (kobo-258 route).
  try { void spawn(["hey", oracle, `🧵 you're pulled into brainstorm room "${room}" (${company}) — /room?company=${encodeURIComponent(company)}&room=${encodeURIComponent(room)}`]).exited; } catch { /* notify best-effort */ }
  return Response.json({ ok: true, room: updated });
}

/**
 * POST /api/room/open — body { company, room, topic } → create/reopen the off-card
 * artifact rooms/<id>.json (idempotent; a reopen keeps the thread). Returns the room.
 */
export async function handleRoomOpenRequest(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  const company = str(body.company), room = str(body.room), topic = str(body.topic);
  if (!company || !room) return Response.json({ ok: false, error: "company and room are required" }, { status: 400 });
  // kobo-258 baseline: a room is ALWAYS ⊂ a company — never mint one under a company
  // that doesn't exist (no orphan room). Enforced server-side at the birth point.
  if (!companyExists(company)) return Response.json({ ok: false, error: `unknown company: ${company}` }, { status: 404 });
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
  // kobo-322: pagination — default-cap the thread so a huge room never dumps whole.
  const page = parseRoomPageOpts(url.searchParams);
  if ("error" in page) return Response.json({ ok: false, error: page.error }, { status: 400 });
  const total = r.messages.length;
  const messages = paginateRoomMessages(r.messages, page);
  return Response.json({
    ok: true,
    room: { ...r, messages },
    totalMessages: total,
    returnedMessages: messages.length,
    truncated: messages.length < total,
  });
}

/**
 * kobo-322: parse ?last / ?since / ?all query params for room-read pagination.
 * `since` accepts epoch-ms OR an ISO date string; malformed → explicit error (never
 * a silent empty result). `last` must be a non-negative integer.
 * kobo-357: ?offset pages backward through history (skip N from the tail before
 * taking `last`) — same non-negative-integer validation as `last`.
 */
function parseRoomPageOpts(params: URLSearchParams): RoomPageOpts | { error: string } {
  const opts: RoomPageOpts = {};
  const all = params.get("all");
  if (all !== null && all !== "0" && all !== "false") opts.all = true;

  const last = params.get("last");
  if (last !== null && last !== "") {
    const n = Number(last);
    if (!Number.isInteger(n) || n < 0) return { error: `invalid last: ${last} (expected a non-negative integer)` };
    opts.last = n;
  }

  const offset = params.get("offset");
  if (offset !== null && offset !== "") {
    const n = Number(offset);
    if (!Number.isInteger(n) || n < 0) return { error: `invalid offset: ${offset} (expected a non-negative integer)` };
    opts.offset = n;
  }

  const since = params.get("since");
  if (since !== null && since !== "") {
    const ms = /^\d+$/.test(since.trim()) ? Number(since) : Date.parse(since);
    if (!Number.isFinite(ms)) return { error: `invalid since: ${since} (expected epoch ms or ISO date)` };
    opts.since = ms;
  }
  return opts;
}

/**
 * GET /api/rooms?company=<c> — the company-scoped room list for the 2-pane chat
 * (kobo-258). Drives the topic list + the company selector + the default partner:
 *   { ok, company, lead, companies:[names], rooms:[{id,topic,status,updatedTs,cardId}] }
 * `company` omitted / unknown → default to the first company (rooms are ALWAYS ⊂ a
 * company — the UI never operates without one). `lead` = the oracle that runs that
 * company's warroom (kobo→eq3, pgw→thawanban). Read-only.
 */
export function handleRoomsListRequest(request: Request): Response {
  const companies = listCompanies().map((c) => c.name);
  const asked = (new URL(request.url).searchParams.get("company") ?? "").trim();
  const company = asked && companies.includes(asked) ? asked : (companies[0] ?? "");
  if (!company) return Response.json({ ok: true, company: "", lead: null, companies: [], rooms: [] });
  const rooms = listRooms(company).map((r) => ({ id: r.id, topic: r.topic, status: r.status, updatedTs: r.updatedTs, cardId: r.cardId }));
  return Response.json({ ok: true, company, lead: companyLead(company), companies, rooms });
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
