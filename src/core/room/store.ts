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

export type RoomStatus = "open" | "closed";

export interface RoomMessage {
  id: string; // source message-lifecycle id — dedup key (a hey can emit >1 feed event)
  from: string;
  text: string; // the message with its [room:<id>] tag already stripped
  ts: number;
}

export interface RoomArtifact {
  id: string;
  company: string;
  topic: string;
  status: RoomStatus;
  ts: number; // opened at
  updatedTs: number;
  messages: RoomMessage[];
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
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RoomArtifact;
  } catch {
    return null; // corrupt/partial → treat as absent (never throw on read)
  }
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
 */
export function appendRoomMessage(company: string, id: string, msg: RoomMessage): RoomArtifact | null {
  const room = readRoom(company, id);
  if (!room) return null;
  if (room.messages.some((m) => m.id === msg.id)) return room; // dedup — already captured
  room.messages.push(msg);
  room.updatedTs = msg.ts || Date.now();
  writeRoom(room);
  return room;
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
