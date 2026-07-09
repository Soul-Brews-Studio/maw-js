import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openRoom, closeRoom, reopenRoom, appendRoomMessage, readRoom, listRooms, findRoomCompany, roomFilePath, linkRoomCard, mergeRooms, addRoomParticipant } from "./store";
import { taskFilePath } from "../tasks/store";

let dir: string; const prev = process.env.MAW_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-room-")); process.env.MAW_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

describe("room artifact store (kobo-241 — off-card, file-per-room)", () => {
  test("openRoom creates an OFF-CARD artifact under rooms/, NOT the kanban tasks/ dir", () => {
    const r = openRoom("kobo", "demo", "what to build");
    expect(r).toMatchObject({ id: "demo", company: "kobo", topic: "what to build", status: "open", messages: [] });
    expect(existsSync(roomFilePath("kobo", "demo"))).toBe(true);
    expect(roomFilePath("kobo", "demo")).toContain("/rooms/"); // NOT /tasks/
    expect(existsSync(taskFilePath("kobo", "demo"))).toBe(false); // never a kanban card
  });

  test("addRoomParticipant records a pulled-in teammate, idempotent; null on an absent room (kobo-260)", () => {
    openRoom("kobo", "r1", "topic");
    expect(addRoomParticipant("kobo", "r1", "thawanban")!.participants).toEqual(["thawanban"]);
    expect(addRoomParticipant("kobo", "r1", "thawanban")!.participants).toEqual(["thawanban"]); // idempotent — no dup
    expect(addRoomParticipant("kobo", "r1", "worker-2")!.participants).toEqual(["thawanban", "worker-2"]);
    expect(readRoom("kobo", "r1")!.participants).toEqual(["thawanban", "worker-2"]); // persisted
    expect(addRoomParticipant("kobo", "ghost", "x")).toBeNull(); // absent room
  });

  test("close / reopen flip status but PRESERVE the thread (persist + reload)", () => {
    openRoom("kobo", "r1", "topic");
    appendRoomMessage("kobo", "r1", { id: "m1", from: "web", text: "hi lead", ts: 1 });
    expect(closeRoom("kobo", "r1")!.status).toBe("closed");
    expect(readRoom("kobo", "r1")!.messages).toHaveLength(1); // thread survives close
    const re = reopenRoom("kobo", "r1")!;
    expect(re.status).toBe("open");
    expect(re.messages).toHaveLength(1); // reopen reloads the full thread
    expect(re.topic).toBe("topic"); // reopen keeps the topic
  });

  test("appendRoomMessage is idempotent by source id (a hey emits >1 feed event)", () => {
    openRoom("kobo", "r2", "t");
    appendRoomMessage("kobo", "r2", { id: "mA", from: "web", text: "q", ts: 1 });
    appendRoomMessage("kobo", "r2", { id: "mA", from: "web", text: "q", ts: 1 }); // dup → skipped
    appendRoomMessage("kobo", "r2", { id: "mB", from: "eq3", text: "a", ts: 2 });
    expect(readRoom("kobo", "r2")!.messages.map((m) => m.id)).toEqual(["mA", "mB"]);
  });

  test("appendRoomMessage on an UNOPENED room → null (stray traffic never mints an artifact)", () => {
    expect(appendRoomMessage("kobo", "ghost", { id: "x", from: "a", text: "b", ts: 1 })).toBeNull();
    expect(existsSync(roomFilePath("kobo", "ghost"))).toBe(false);
  });

  test("kobo-249: windowed (from,text) dedup — send-write absorbs the lagging feed event", () => {
    openRoom("kobo", "r5", "t");
    // handler persists at send time (id A), then the SAME turn's delayed feed event
    // arrives with a DIFFERENT random id but identical (from, text) INSIDE the window → deduped.
    appendRoomMessage("kobo", "r5", { id: "send-A", from: "web:web", text: "hi", ts: 1 });
    appendRoomMessage("kobo", "r5", { id: "feed-random", from: "web:web", text: "hi", ts: 41_000 }); // +41s, in window
    expect(readRoom("kobo", "r5")!.messages).toHaveLength(1); // one turn, not two
    // a DIFFERENT sender or DIFFERENT text is a distinct turn — still persists
    appendRoomMessage("kobo", "r5", { id: "b", from: "m5:eq3", text: "hi", ts: 2 }); // diff from
    appendRoomMessage("kobo", "r5", { id: "c", from: "web:web", text: "bye", ts: 3 }); // diff text
    expect(readRoom("kobo", "r5")!.messages.map((m) => m.text)).toEqual(["hi", "hi", "bye"]);
  });

  test("kobo-249 (eq3 review): a genuine identical repeat AFTER the window survives — no permanent drop", () => {
    openRoom("kobo", "r6", "t");
    // "ok"/"ใช่" is normal room chatter — the same author re-typing it minutes later is a
    // REAL new turn, not the lagging feed duplicate. It must NOT be silently dropped.
    appendRoomMessage("kobo", "r6", { id: "m1", from: "web:tony", text: "ok", ts: 1_000 });
    appendRoomMessage("kobo", "r6", { id: "m2", from: "web:tony", text: "ok", ts: 1_000 + 200_000 }); // +200s > 120s window
    expect(readRoom("kobo", "r6")!.messages).toHaveLength(2); // both survive
  });

  test("reopen of an absent room → null; findRoomCompany resolves the owning company", () => {
    expect(reopenRoom("kobo", "nope")).toBeNull();
    openRoom("kobo", "here", "t");
    expect(findRoomCompany("here")).toBe("kobo");
    expect(findRoomCompany("nowhere")).toBeNull();
  });

  test("listRooms returns a company's rooms newest-first (id/topic/status)", () => {
    openRoom("kobo", "a", "ta"); openRoom("kobo", "b", "tb");
    const ids = listRooms("kobo").map((r) => r.id);
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(listRooms("other")).toEqual([]);
  });

  test("linkRoomCard records the distilled card id (bidirectional back-half); null if absent", () => {
    openRoom("kobo", "r3", "t");
    const linked = linkRoomCard("kobo", "r3", "kobo-99");
    expect(linked!.cardId).toBe("kobo-99");
    expect(readRoom("kobo", "r3")!.cardId).toBe("kobo-99"); // persisted
    expect(linkRoomCard("kobo", "r3", "kobo-99")!.cardId).toBe("kobo-99"); // idempotent re-link
    expect(linkRoomCard("kobo", "ghost", "kobo-1")).toBeNull(); // absent room
  });
});

describe("mergeRooms (kobo-243 — lead-driven consolidation, Nothing Deleted)", () => {
  test("target absorbs source threads (time-ordered, deduped); sources ARCHIVED not deleted", () => {
    openRoom("kobo", "t", "how to ship");
    appendRoomMessage("kobo", "t", { id: "t1", from: "web", text: "target msg", ts: 10 });
    openRoom("kobo", "s", "same problem, other room");
    appendRoomMessage("kobo", "s", { id: "s1", from: "web", text: "source msg", ts: 5 });
    appendRoomMessage("kobo", "s", { id: "s2", from: "eq3", text: "src reply", ts: 20 });

    const merged = mergeRooms("kobo", "t", ["s"])!;
    expect(merged.messages.map((m) => m.id)).toEqual(["s1", "t1", "s2"]); // one time-ordered thread
    expect(merged.mergedFrom).toEqual(["s"]); // provenance on the target

    const src = readRoom("kobo", "s")!;
    expect(src.status).toBe("merged"); // archived
    expect(src.mergedInto).toBe("t"); // linked to the survivor
    expect(existsSync(roomFilePath("kobo", "s"))).toBe(true); // NOT deleted (Principle 1)
    expect(src.messages).toHaveLength(2); // source thread preserved intact
  });

  test("dedup by source id — a shared msg id isn't double-counted", () => {
    openRoom("kobo", "t", "t"); appendRoomMessage("kobo", "t", { id: "dup", from: "a", text: "x", ts: 1 });
    openRoom("kobo", "s", "s"); appendRoomMessage("kobo", "s", { id: "dup", from: "a", text: "x", ts: 1 });
    expect(mergeRooms("kobo", "t", ["s"])!.messages.map((m) => m.id)).toEqual(["dup"]);
  });

  test("absent target → null; self / absent / already-merged sources are skipped", () => {
    expect(mergeRooms("kobo", "ghost", ["s"])).toBeNull();
    openRoom("kobo", "t", "t");
    const r = mergeRooms("kobo", "t", ["t", "nope"])!; // self + absent → nothing absorbed
    expect(r.mergedFrom).toBeUndefined();
    // already-merged source is not re-absorbed
    openRoom("kobo", "s", "s"); mergeRooms("kobo", "t", ["s"]);
    const again = mergeRooms("kobo", "t", ["s"])!;
    expect(again.mergedFrom).toEqual(["s"]); // still just one entry, not ["s","s"]
  });
});
