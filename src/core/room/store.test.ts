import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openRoom, closeRoom, reopenRoom, appendRoomMessage, readRoom, listRooms, findRoomCompany, roomFilePath, linkRoomCard, mergeRooms, addRoomParticipant, paginateRoomMessages, ROOM_DEFAULT_LAST, type RoomMessage } from "./store";
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

describe("paginateRoomMessages (kobo-322 — default-cap room reads)", () => {
  const msgs = (n: number): RoomMessage[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m${i}`, from: "a", text: "x", ts: i + 1, seq: i + 1 }));

  test("no params → the last ROOM_DEFAULT_LAST turns (footgun guard, not full dump)", () => {
    const out = paginateRoomMessages(msgs(50));
    expect(out).toHaveLength(ROOM_DEFAULT_LAST);
    expect(out[0].id).toBe(`m${50 - ROOM_DEFAULT_LAST}`); // tail slice
    expect(out.at(-1)!.id).toBe("m49");
  });

  test("no params but fewer than the cap → all of them (no padding)", () => {
    expect(paginateRoomMessages(msgs(3))).toHaveLength(3);
  });

  test("last N → the last N turns", () => {
    const out = paginateRoomMessages(msgs(50), { last: 10 });
    expect(out).toHaveLength(10);
    expect(out[0].id).toBe("m40");
  });

  test("last N > available → all (no error, no throw)", () => {
    expect(paginateRoomMessages(msgs(3), { last: 99 })).toHaveLength(3);
  });

  test("all → full dump; last 0 is the same escape hatch", () => {
    expect(paginateRoomMessages(msgs(50), { all: true })).toHaveLength(50);
    expect(paginateRoomMessages(msgs(50), { last: 0 })).toHaveLength(50);
  });

  test("since → only turns at/after ts (inclusive); alone = its own cap (no default 20)", () => {
    const out = paginateRoomMessages(msgs(50), { since: 45 }); // ts 45..50
    expect(out.map((m) => m.ts)).toEqual([45, 46, 47, 48, 49, 50]);
  });

  test("since + last compose: filter by time, then tail-slice", () => {
    const out = paginateRoomMessages(msgs(50), { since: 40, last: 3 }); // ts 40..50 → last 3
    expect(out.map((m) => m.ts)).toEqual([48, 49, 50]);
  });

  // kobo-357: `offset` skips N turns from the tail before taking `last` — pages
  // BACKWARD through history (offset:0 = newest page, offset:last = the page before).
  describe("offset (kobo-357 — page backward through history)", () => {
    test("last:6 offset:6 → the 7th-12th newest (skip the 6 newest, then take 6)", () => {
      const out = paginateRoomMessages(msgs(50), { last: 6, offset: 6 });
      expect(out.map((m) => m.ts)).toEqual([39, 40, 41, 42, 43, 44]); // m38..m43 (0-idx) → ts 39..44
    });

    test("offset:0 (or omitted) is identical to plain last:N (no regression)", () => {
      const withZero = paginateRoomMessages(msgs(50), { last: 10, offset: 0 });
      const without = paginateRoomMessages(msgs(50), { last: 10 });
      expect(withZero).toEqual(without);
    });

    test("offset larger than available → empty (no throw, no negative-index wraparound)", () => {
      expect(paginateRoomMessages(msgs(10), { last: 5, offset: 20 })).toHaveLength(0);
    });

    test("offset without last → offset applied against the default cap", () => {
      const out = paginateRoomMessages(msgs(50), { offset: 10 });
      expect(out).toHaveLength(ROOM_DEFAULT_LAST);
      expect(out.at(-1)!.ts).toBe(40); // newest 10 skipped (ts 41..50), so the page ends at ts 40
    });

    test("offset + since compose: filter by time, skip from the tail, then take last", () => {
      const out = paginateRoomMessages(msgs(50), { since: 30, last: 5, offset: 5 }); // ts 30..50 (21 msgs) → skip newest 5 → take 5
      expect(out.map((m) => m.ts)).toEqual([41, 42, 43, 44, 45]);
    });

    test("offset is ignored under `all` (full dump — no partial-skip escape hatch)", () => {
      expect(paginateRoomMessages(msgs(50), { all: true, offset: 10 })).toHaveLength(50);
    });
  });
});

describe("room message seq (kobo-415 — company-wide, unique by construction)", () => {
  test("appendRoomMessage mints an increasing seq, stable across repeat reads", () => {
    openRoom("kobo", "r1", "topic");
    appendRoomMessage("kobo", "r1", { id: "m1", from: "a", text: "hi", ts: 1 });
    const after = appendRoomMessage("kobo", "r1", { id: "m2", from: "b", text: "yo", ts: 2 })!;
    const [m1, m2] = after.messages;
    expect(m1.seq).toBeGreaterThan(0);
    expect(m2.seq).toBe(m1.seq + 1);
    expect(readRoom("kobo", "r1")!.messages.map((m) => m.seq)).toEqual([m1.seq, m2.seq]); // no drift
    expect(readRoom("kobo", "r1")!.messages.map((m) => m.seq)).toEqual([m1.seq, m2.seq]); // repeat read, still stable
  });

  test("seq is company-wide, not per-room — a second room does NOT restart at 1", () => {
    openRoom("kobo", "a", "a");
    openRoom("kobo", "b", "b");
    const a = appendRoomMessage("kobo", "a", { id: "a1", from: "x", text: "x", ts: 1 })!;
    const b = appendRoomMessage("kobo", "b", { id: "b1", from: "x", text: "x", ts: 1 })!;
    expect(b.messages[0].seq).toBe(a.messages[0].seq + 1);
  });

  test("concurrent-tick appends (identical ts) still get distinct seq", () => {
    openRoom("kobo", "r1", "topic");
    appendRoomMessage("kobo", "r1", { id: "m1", from: "a", text: "x", ts: 100 });
    appendRoomMessage("kobo", "r1", { id: "m2", from: "b", text: "y", ts: 100 });
    const seqs = readRoom("kobo", "r1")!.messages.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(2);
  });

  test("readRoom backfills a legacy message with no seq — idempotent across re-reads", () => {
    openRoom("kobo", "legacy", "topic");
    // bypass the store to simulate a room persisted BEFORE this feature shipped (no seq field)
    const raw = JSON.parse(readFileSync(roomFilePath("kobo", "legacy"), "utf8"));
    raw.messages = [
      { id: "old1", from: "a", text: "x", ts: 1 },
      { id: "old2", from: "b", text: "y", ts: 2 },
    ];
    writeFileSync(roomFilePath("kobo", "legacy"), JSON.stringify(raw));

    const first = readRoom("kobo", "legacy")!;
    expect(first.messages.every((m) => typeof m.seq === "number")).toBe(true); // no error, not empty
    expect(new Set(first.messages.map((m) => m.seq)).size).toBe(2); // distinct

    const second = readRoom("kobo", "legacy")!;
    expect(second.messages.map((m) => m.seq)).toEqual(first.messages.map((m) => m.seq)); // no drift on repeat open
  });

  // THE BINDING AC (eq3 ruling): the guard must CONSTRUCT the collision two
  // independently-numbered rooms would produce under a naive per-room counter, then
  // assert it can't happen — not just observe a freshly built dataset (which has no
  // collision to find). Verified RED-then-GREEN during dev: temporarily keying
  // nextRoomSeq per-room (the rejected/naive design) makes this test fail with two
  // duplicate seq after merge; the shipped company-wide counter makes it pass.
  test("mergeRooms: two independently-numbered rooms merge with NO duplicate seq", () => {
    openRoom("kobo", "t", "target");
    appendRoomMessage("kobo", "t", { id: "t1", from: "a", text: "x", ts: 10 });
    openRoom("kobo", "s", "source");
    appendRoomMessage("kobo", "s", { id: "s1", from: "b", text: "y", ts: 5 });
    appendRoomMessage("kobo", "s", { id: "s2", from: "c", text: "z", ts: 20 });

    const merged = mergeRooms("kobo", "t", ["s"])!;
    const seqs = merged.messages.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no two messages share a seq
  });
});
