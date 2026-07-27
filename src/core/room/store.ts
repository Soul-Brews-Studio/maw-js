/**
 * Brainstorm Room artifact store (kobo-241, slice 2).
 *
 * A "room" is an OFF-CARD note-thread artifact — a grounding conversation that lives
 * OUTSIDE the kanban and can be reopened. It reuses the task store's proven
 * file-per-artifact PATTERN (mawDataPath + atomic JSON write), but a DIFFERENT
 * directory: `~/.maw/companies/<c>/rooms/<id>.json`. Because it's `rooms/` and not
 * `tasks/`, it is NEVER read by /api/tasks — it can't appear on a kanban lane
 * (front-confirmed store choice, kobo-241). NO new store mechanism/DB/transport.
 *
 * The thread persists here (durable, survives restart) so a reopen reloads the full
 * conversation. Turns are appended by the feed listener (src/core/room/listener.ts)
 * off the SAME [room:<id>] hey events the slice-1 wire already emits — no new capture.
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync } from "fs";
import { mawDataPath } from "../xdg";

// kobo-415 item 5 — injection seam for mintRoomSeqBatch, same shape as
// src/commands/shared/fleet-ensure.ts (deps.fn ?? fn), so a test can assert the
// real invariant (one write regardless of message count) instead of a timing proxy.
interface MintRoomSeqDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  mkdirSync?: typeof mkdirSync;
}

export type RoomStatus = "open" | "closed" | "merged";

export interface RoomMessage {
  id: string; // source message-lifecycle id — dedup key (a hey can emit >1 feed event)
  from: string;
  text: string; // the message with its [room:<id>] tag already stripped
  ts: number;
  // kobo-415: company-wide (not per-room) — minted once at append, never re-derived, so
  // mergeRooms unions two rooms' messages without colliding TODAY. Non-contiguous within a
  // room after a merge (3, then 9, then 14) — never compute a "messages missed" count by
  // subtracting seq; count actual messages instead.
  // UNIQUENESS IS AN OPERATIONAL INVARIANT, NOT A CODE GUARANTEE (kobo-415 reviewer verdict,
  // 2026-07-27): it holds only because exactly one maw-server process writes this data dir
  // today (see nextRoomSeq below). A second writer — e.g. a future CLI verb that calls
  // appendRoomMessage directly instead of going through the server's HTTP route — WILL mint
  // duplicate seq, with nothing here to catch it.
  seq: number;
}

export interface RoomArtifact {
  id: string;
  company: string;
  topic: string;
  status: RoomStatus;
  ts: number; // opened at
  updatedTs: number;
  messages: RoomMessage[];
  cardId?: string; // kobo-244: the kanban card distilled FROM this room (bidirectional provenance — the card records this room id back). The single point where a room touches the board.
  mergedInto?: string; // kobo-243: set on a SOURCE room — the target it was consolidated into (archived, not deleted)
  mergedFrom?: string[]; // kobo-243: set on the TARGET room — the source ids it absorbed (provenance)
  participants?: string[]; // kobo-260: teammates EXPLICITLY pulled in (invite) — union'd with the derived (spoken-in-thread) participants so a pulled-in teammate shows before their first turn
}

/** company/id → safe single path segment (no traversal / separators / dots). */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function roomsDir(company: string): string {
  return mawDataPath("companies", safeSegment(company), "rooms");
}

export function roomFilePath(company: string, id: string): string {
  return mawDataPath("companies", safeSegment(company), "rooms", `${safeSegment(id)}.json`);
}

/** Kept OUTSIDE rooms/ — a rooms/ dotfile would still end in .json and get scanned by listRooms. */
function roomSeqCounterPath(company: string): string {
  return mawDataPath("companies", safeSegment(company), "room-seq.json");
}

/**
 * Mint `count` sequential company-wide seq numbers in ONE read+write (kobo-415 blocker 2 —
 * backfilling a legacy room used to call this once PER message, each a separate sync disk
 * write; a 5000-message room measured ~700ms blocking the event loop on that one readRoom).
 * A persisted counter, not a scan — so backfilling one legacy room's messages never has to
 * re-derive the company max from every other room (which would recurse back through
 * readRoom's own backfill below).
 *
 * NOT cross-process safe: this is an unguarded read-increment-write, no lock. It is only
 * correct because every call today funnels through the single maw-server pm2 process (fork
 * mode, one instance) — appendRoomMessage is reached from route.ts/listener.ts only, never
 * from a CLI verb, and the MCP server talks to it over HTTP
 * (src/vendor/mpr-plugins/mcp/room-client.ts), not in-process. If a second writer to this
 * data dir is ever added — e.g. a CLI verb calling appendRoomMessage directly, or the server
 * running as more than one instance — this WILL mint duplicate seq. A real cross-process
 * guard (see src/lib/peers/lock.ts withPeersLock for the fd-based O_EXCL pattern already
 * used elsewhere) is a follow-up, not fixed here (kobo-415 reviewer verdict, 2026-07-27).
 *
 * FAIL LOUD on the two cases this CAN actually catch without that lock (kobo-415 lead
 * ruling — cannot resolve correctness → throw, never guess and continue, same principle as
 * kobo-431 item b):
 *   1. Unresolvable input — a corrupt/truncated counter file, or one missing its `seq`
 *      field. The old code silently treated both as "start over at 0", which re-mints every
 *      number already in use. Now it throws instead.
 *   2. A read-back mismatch right after this call's own write — if the counter doesn't read
 *      back as exactly what we just persisted, another writer's rename landed inside our own
 *      write window, or something rolled the file back underneath us.
 * WHAT THIS DOES NOT AND CANNOT CATCH: two processes reading the SAME starting count before
 * either has written (the classic lost-update race). Each computes a range that looks
 * perfectly valid from where it stands, and each one's own read-back matches its own write —
 * there is nothing here for either process to notice. A per-room or per-company scan for
 * "is this number already used" would not close that gap either: the measured collisions
 * were CROSS-room, and a scan checking only the room being written would pass every time —
 * decorative, not a guard. Closing the real race needs the company-wide lock this design
 * deliberately avoided for cost (eq3 follow-up card).
 */
function mintRoomSeqBatch(company: string, count: number, deps: MintRoomSeqDeps = {}): number[] {
  if (count <= 0) return [];
  const path = roomSeqCounterPath(company);
  const readCounter = (): number => {
    if (!(deps.existsSync ?? existsSync)(path)) return 0; // no counter file yet — legitimate first mint
    const raw = (deps.readFileSync ?? readFileSync)(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`kobo-415: room-seq counter for company "${company}" at ${path} is corrupt — refusing to silently reset to 0, which would re-mint every seq already in use: ${e}`);
    }
    const seq = (parsed as { seq?: unknown })?.seq;
    if (typeof seq !== "number" || !Number.isFinite(seq)) {
      throw new Error(`kobo-415: room-seq counter for company "${company}" at ${path} has no valid seq field (got ${JSON.stringify(seq)}) — refusing to silently reset to 0`);
    }
    return seq;
  };
  const n = readCounter();
  const nums = Array.from({ length: count }, (_, i) => n + i + 1);
  (deps.mkdirSync ?? mkdirSync)(mawDataPath("companies", safeSegment(company)), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  (deps.writeFileSync ?? writeFileSync)(tmp, JSON.stringify({ seq: n + count }) + "\n");
  (deps.renameSync ?? renameSync)(tmp, path);
  const persisted = readCounter();
  if (persisted !== n + count) {
    throw new Error(`kobo-415: room-seq counter for company "${company}" reads back as ${persisted} right after minting ${count}, expected ${n + count} — another writer or a rollback landed in the write window; refusing to trust seq ${nums[0]}-${nums[nums.length - 1]}`);
  }
  return nums;
}

function nextRoomSeq(company: string): number {
  return mintRoomSeqBatch(company, 1)[0];
}

/** Atomic overwrite — temp file in the same dir, then rename (mirrors the task store). */
function writeRoom(room: RoomArtifact): void {
  const path = roomFilePath(room.company, room.id);
  mkdirSync(roomsDir(room.company), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(room, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readRoom(company: string, id: string): RoomArtifact | null {
  const path = roomFilePath(company, id);
  if (!existsSync(path)) return null;
  let room: RoomArtifact;
  try {
    room = JSON.parse(readFileSync(path, "utf8")) as RoomArtifact;
  } catch {
    return null; // corrupt/partial → treat as absent (never throw on read)
  }
  if (backfillRoomSeq(room)) writeRoom(room); // kobo-415: legacy room, minted once, then never again
  return room;
}

/**
 * kobo-415: a room persisted before this feature has messages with no `seq` — mint numbers
 * for all of them in ONE mintRoomSeqBatch call (one disk read, one disk write total), in
 * existing (already time-ordered) array order. Idempotent: a room with every message
 * already numbered is untouched (no write, no seq churn on repeat reads).
 */
function backfillRoomSeq(room: RoomArtifact): boolean {
  const unnumbered = room.messages.filter((m) => m.seq === undefined);
  if (!unnumbered.length) return false;
  const nums = mintRoomSeqBatch(room.company, unnumbered.length);
  unnumbered.forEach((m, i) => { m.seq = nums[i]; });
  return true;
}

/**
 * kobo-322: pagination for room-read. A 120K-char room dumped whole blows the MCP
 * token cap, so reads are CAPPED BY DEFAULT (last 20 turns) with explicit escape
 * hatches — opt-in caps would leave the footgun in place (still dump by default).
 *
 *  - `since` (epoch ms) — keep only turns at/after that time (applied first)
 *  - `last N` — keep the last N turns; N > available → all (no error). N === 0 = escape hatch (all)
 *  - `all` — full dump, skip the default cap
 *  - none of the above → DEFAULT to the last ROOM_DEFAULT_LAST turns
 *
 * `since` composes with `last`: filter by time, then tail-slice. `since` alone (no
 * `last`) returns every matching turn (an explicit time-bound is itself the cap).
 */
export const ROOM_DEFAULT_LAST = 20;

export interface RoomPageOpts {
  last?: number; // last N turns; 0 = all (escape hatch)
  since?: number; // epoch ms — keep turns with ts >= since
  all?: boolean; // full dump, ignore default cap
  offset?: number; // kobo-357: skip this many turns from the tail before taking `last` — pages BACKWARD through history (offset:0 = newest page, offset:last = the page before)
}

export function paginateRoomMessages(messages: RoomMessage[], opts: RoomPageOpts = {}): RoomMessage[] {
  let out = messages;
  if (opts.since !== undefined) out = out.filter((m) => m.ts >= opts.since!);
  if (opts.all || opts.last === 0) return out; // explicit escape hatch → no cap (offset doesn't apply to a full dump)
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  if (opts.last !== undefined) {
    const end = Math.max(0, out.length - offset);
    return out.slice(Math.max(0, end - opts.last), end);
  }
  if (opts.since !== undefined) return offset > 0 ? out.slice(0, Math.max(0, out.length - offset)) : out; // explicit time-bound = its own cap; offset still trims the tail
  const end = Math.max(0, out.length - offset);
  return out.slice(Math.max(0, end - ROOM_DEFAULT_LAST), end); // no `last` → default cap, offset shifts the page back
}

/**
 * Open a room (idempotent). A fresh id → a new open artifact with the topic + an
 * empty thread. An EXISTING room → reopened (status→open, thread preserved); the
 * topic is updated only if a non-empty one is passed. Returns the artifact.
 */
export function openRoom(company: string, id: string, topic: string): RoomArtifact {
  const now = Date.now();
  const existing = readRoom(company, id);
  if (existing) {
    existing.status = "open"; // reopen keeps the thread
    if (topic.trim()) existing.topic = topic.trim();
    existing.updatedTs = now;
    writeRoom(existing);
    return existing;
  }
  const room: RoomArtifact = { id, company, topic: topic.trim(), status: "open", ts: now, updatedTs: now, messages: [] };
  writeRoom(room);
  return room;
}

/** Close a room — status→closed, thread preserved (reopen brings it back). null if absent. */
export function closeRoom(company: string, id: string): RoomArtifact | null {
  const room = readRoom(company, id);
  if (!room) return null;
  room.status = "closed";
  room.updatedTs = Date.now();
  writeRoom(room);
  return room;
}

/** Reopen a closed room (thread preserved). Alias of openRoom with no topic change. */
export function reopenRoom(company: string, id: string): RoomArtifact | null {
  const room = readRoom(company, id);
  if (!room) return null;
  return openRoom(company, id, ""); // "" → keep the existing topic
}

/**
 * Append a turn to a room's thread. Idempotent by source message id — a hey can emit
 * multiple lifecycle feed events (queued→delivered, outbound+inbound) for ONE message,
 * so we skip a msgId that's already stored. Returns the room, or null if the room
 * doesn't exist (only OPENED rooms persist a thread — an untagged/unopened room is
 * ignored, so stray traffic never mints an artifact).
 *
 * kobo-249: the room/send handler now persists an outbound turn SYNCHRONOUSLY at send
 * time (the artifact is the source of truth, decoupled from the idle-gated delivery feed
 * event). The SAME turn's feed event still arrives later (lagging under a busy pane) with
 * a DIFFERENT random lifecycle id — so we ALSO dedup by identical (from, text) BUT only
 * within a bounded window around the send-write (SEND_DEDUP_WINDOW_MS): that catches the
 * send↔feed pair (measured lag +40s), while a genuine re-typed identical turn later
 * ("ok"/"ใช่" is normal room chatter) survives as a new turn — no permanent drop (eq3
 * review, kobo-249). id-dedup is kept for the >1-lifecycle-event case.
 */
const SEND_DEDUP_WINDOW_MS = 120_000; // send-write ↔ its lagging delivery feed event (~2 min covers the measured drain)

export function appendRoomMessage(company: string, id: string, msg: Omit<RoomMessage, "seq">): RoomArtifact | null {
  const room = readRoom(company, id);
  if (!room) return null;
  if (room.messages.some((m) => m.id === msg.id)) return room; // dedup — same lifecycle id
  if (msg.text && room.messages.some((m) => m.from === msg.from && m.text === msg.text && Math.abs((m.ts || 0) - (msg.ts || 0)) < SEND_DEDUP_WINDOW_MS)) return room; // dedup — same turn (send-write ↔ lagging feed event), windowed so genuine later repeats survive (kobo-249)
  room.messages.push({ ...msg, seq: nextRoomSeq(company) }); // kobo-415: company-wide, minted here — never touched again
  room.updatedTs = msg.ts || Date.now();
  writeRoom(room);
  return room;
}

/**
 * Record an explicitly pulled-in teammate on the room (kobo-260 invite). Idempotent —
 * a re-invite is a no-op. Returns the room, or null if absent. The stored list is union'd
 * with the derived (spoken-in-thread) participants by roomActivity, so a teammate shows in
 * "who's here" the moment they're invited, before their first turn.
 */
export function addRoomParticipant(company: string, id: string, oracle: string): RoomArtifact | null {
  const room = readRoom(company, id);
  if (!room) return null;
  if (!room.participants) room.participants = [];
  if (room.participants.includes(oracle)) return room; // already in — no-op
  room.participants.push(oracle);
  room.updatedTs = Date.now();
  writeRoom(room);
  return room;
}

/**
 * Record on the artifact the kanban card it was distilled into (kobo-244) — the
 * back-half of the bidirectional link (the card already carries room=<id>). Returns
 * the room, or null if absent. Idempotent: re-linking the same card is a no-op write.
 */
export function linkRoomCard(company: string, id: string, cardId: string): RoomArtifact | null {
  const room = readRoom(company, id);
  if (!room) return null;
  room.cardId = cardId;
  room.updatedTs = Date.now();
  writeRoom(room);
  return room;
}

/**
 * Consolidate SOURCE rooms into a TARGET room (kobo-243, slice 4). Lead-proposed +
 * human-CONFIRMED at the route layer — this fn only EXECUTES a confirmed merge, it never
 * decides to merge. The target absorbs every source thread (messages merged, deduped by
 * id, time-ordered) so it holds all conversations; each source is ARCHIVED
 * (status→"merged", mergedInto=target) and NEVER deleted (Principle 1: Nothing is
 * Deleted — the source artifact stays on disk, linked for provenance). The target records
 * every absorbed id in mergedFrom. Returns the merged target, or null if the target is
 * absent. Sources that don't exist, equal the target, or are already merged are skipped.
 */
export function mergeRooms(company: string, targetId: string, sourceIds: string[]): RoomArtifact | null {
  const target = readRoom(company, targetId);
  if (!target) return null;
  const absorbed: string[] = [];
  for (const sid of sourceIds) {
    if (sid === targetId) continue; // never merge a room into itself
    const src = readRoom(company, sid);
    if (!src || src.status === "merged") continue; // absent / already consolidated
    for (const m of src.messages) {
      if (!target.messages.some((t) => t.id === m.id)) target.messages.push(m); // dedup by source msg id
    }
    src.status = "merged";
    src.mergedInto = targetId;
    src.updatedTs = Date.now();
    writeRoom(src); // archive the source — kept, not deleted
    absorbed.push(sid);
  }
  if (!absorbed.length) return target; // nothing to merge — target unchanged
  target.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0)); // one time-ordered thread
  target.mergedFrom = [...(target.mergedFrom ?? []), ...absorbed];
  target.updatedTs = Date.now();
  writeRoom(target);
  return target;
}

/** Every room in a company (for the room list / picker). Absent dir → []. */
export function listRooms(company: string): RoomArtifact[] {
  const dir = roomsDir(company);
  if (!existsSync(dir)) return [];
  const out: RoomArtifact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const r = readRoom(company, f.slice(0, -5));
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.updatedTs - a.updatedTs);
}

// listCompanies() is cheap — the feed listener resolves which company owns a bare
// [room:<id>] by finding the artifact under each company's rooms/ dir.
import { listCompanies } from "../tasks/store";

/**
 * The company whose OPENED room owns this bare id — the feed listener uses this to
 * route a [room:<id>] hey to the right artifact without the tag carrying a company
 * (245-compatible). First match wins if the same id exists under two companies (a
 * documented slice-2 edge; room ids are normally per-company-unique). null = no such
 * open/closed room anywhere → the message is ignored (not persisted).
 */
export function findRoomCompany(id: string): string | null {
  for (const company of listCompanies()) {
    if (existsSync(roomFilePath(company, id))) return company;
  }
  return null;
}

// kobo-415 item 5 — same shape as src/commands/shared/fleet-ensure.ts's `_test` export;
// lets a test assert mintRoomSeqBatch's real invariants (one write, throw-on-race)
// directly instead of through a timing proxy.
export const _test = { mintRoomSeqBatch };
