import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openRoom, closeRoom, reopenRoom, appendRoomMessage, readRoom, listRooms, findRoomCompany, roomFilePath, linkRoomCard, mergeRooms, addRoomParticipant, paginateRoomMessages, ROOM_DEFAULT_LAST, _test, type RoomMessage } from "./store";
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

describe("room message seq (kobo-415 — company-wide, single-writer operational invariant)", () => {
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

  test("seq is not derived from ts — identical-ts appends still get distinct seq (sequential, single-process; NOT a concurrency test)", () => {
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

  // kobo-415 reopen, declared beyond lead's locked scope (see PR body): reviewer's
  // tightest uncovered case. appendRoomMessage does TWO mints in one logical operation —
  // readRoom's backfill mints for the legacy messages, THEN appendRoomMessage's own
  // nextRoomSeq mints for the new one — and neither existing test hit it (one uses fresh
  // rooms with no backfill, the other calls readRoom directly without an append after).
  // First case a future async refactor of mintRoomSeqBatch would break.
  test("appending to a LEGACY room does two mints in one operation (backfill, then append) without collision", () => {
    openRoom("kobo", "legacyAppend", "topic");
    const raw = JSON.parse(readFileSync(roomFilePath("kobo", "legacyAppend"), "utf8"));
    raw.messages = [
      { id: "old1", from: "a", text: "x", ts: 1 },
      { id: "old2", from: "b", text: "y", ts: 2 },
    ];
    writeFileSync(roomFilePath("kobo", "legacyAppend"), JSON.stringify(raw));

    const after = appendRoomMessage("kobo", "legacyAppend", { id: "new1", from: "c", text: "z", ts: 3 })!;
    const seqs = after.messages.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(3); // backfilled old1/old2 + the new append, all distinct
    expect(seqs[2]).toBe(Math.max(seqs[0], seqs[1]) + 1); // append's mint follows the backfill's mint, not interleaved
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

  // eq3 found: uniqueness alone doesn't guard STABILITY. A renumber-the-whole-room merge
  // keeps every seq unique (this test's sibling above stays green) while moving every
  // number that was already handed out — exactly the silent-shift Tony picked option (b)
  // to prevent, and now a permanent LINK TARGET via the #msg-N anchor, so a shift breaks
  // every previously shared link rather than just mislabeling a banner. "Doesn't shift"
  // and "isn't duplicated" are the two separate ACs the card named from the start; this
  // is the one that had no test. Verified RED-then-GREEN during dev: temporarily
  // renumbering target.messages sequentially (1..N) after a merge — unique, but every
  // seq moves — fails this test; the shipped mergeRooms (seq untouched, only reordered)
  // passes it.
  // The property under test is "no message's number changes as a result of a merge,
  // WHICHEVER SIDE it came from" — not just "the target room is untouched". Capturing
  // only the target's before-snapshot missed exactly half of that (eq3 found: a mutation
  // renumbering only the ABSORBED source messages passed everything else, 40/0 green).
  // Per-id lookup (not a set/count comparison) on BOTH sides, so a permutation that swaps
  // which message holds which number — same values, wrong owners — still fails: each id's
  // OWN captured value is checked against that same id after merge, nothing else.
  test("mergeRooms does NOT shift the seq of any message — target's own AND the absorbed source's", () => {
    openRoom("kobo", "t2", "target");
    appendRoomMessage("kobo", "t2", { id: "t2a", from: "a", text: "x", ts: 10 });
    appendRoomMessage("kobo", "t2", { id: "t2b", from: "a", text: "y", ts: 15 });
    openRoom("kobo", "s2", "source");
    appendRoomMessage("kobo", "s2", { id: "s2a", from: "b", text: "z", ts: 5 });
    appendRoomMessage("kobo", "s2", { id: "s2b", from: "b", text: "w", ts: 20 });

    const beforeTarget = readRoom("kobo", "t2")!.messages.map((m) => ({ id: m.id, seq: m.seq }));
    const beforeSource = readRoom("kobo", "s2")!.messages.map((m) => ({ id: m.id, seq: m.seq }));
    const merged = mergeRooms("kobo", "t2", ["s2"])!;
    for (const b of [...beforeTarget, ...beforeSource]) {
      const after = merged.messages.find((m) => m.id === b.id)!;
      expect(after.seq).toBe(b.seq); // that SPECIFIC message keeps its OWN number, whichever room it started in
    }
  });

  test("backfilling a large legacy room mints all seq via the batched path — all distinct, no error", () => {
    openRoom("kobo", "biglegacy", "topic");
    const raw = JSON.parse(readFileSync(roomFilePath("kobo", "biglegacy"), "utf8"));
    raw.messages = Array.from({ length: 2000 }, (_, i) => ({ id: `old${i}`, from: "a", text: "x", ts: i }));
    writeFileSync(roomFilePath("kobo", "biglegacy"), JSON.stringify(raw));

    const room = readRoom("kobo", "biglegacy")!;
    expect(new Set(room.messages.map((m) => m.seq)).size).toBe(2000); // all distinct
  });

  // kobo-415 blocker 2 (reviewer) item 5: a timing budget is a PROXY for the real
  // invariant — the actual fix is "one counter read+write regardless of message count",
  // not "fast enough". Assert that directly via the same deps-injection seam used in
  // src/commands/shared/fleet-ensure.ts, so a regression to per-message writes fails on
  // WRITE COUNT rather than surviving until someone's CI happens to be loaded.
  // Verified RED-then-GREEN during dev: reverting backfillRoomSeq to call
  // mintRoomSeqBatch(company, 1) once per message makes the write count scale with
  // message count instead of staying at 1; the real batched call keeps it at 1.
  test("mintRoomSeqBatch performs exactly one counter write regardless of how many numbers it mints", () => {
    let counterValue = 0;
    let writes = 0;
    let mintedThisCall = 0;
    const deps = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ seq: counterValue }),
      writeFileSync: () => { writes++; counterValue += mintedThisCall; },
      renameSync: () => {},
      mkdirSync: () => {},
    };

    mintedThisCall = 1;
    const single = _test.mintRoomSeqBatch("kobo", 1, deps);
    expect(writes).toBe(1);
    expect(single).toEqual([1]);

    writes = 0;
    mintedThisCall = 2000;
    const batch = _test.mintRoomSeqBatch("kobo", 2000, deps);
    expect(writes).toBe(1); // still exactly one write — not 2000
    expect(batch.length).toBe(2000);
  });

  // kobo-415 lead ruling — fail loud on unresolvable input instead of silently
  // resetting the counter to 0, which would re-mint every seq already in use.
  test("mintRoomSeqBatch throws on a corrupt counter file instead of silently resetting to 0", () => {
    const deps = { existsSync: () => true, readFileSync: () => "{not valid json", writeFileSync: () => {}, renameSync: () => {}, mkdirSync: () => {} };
    expect(() => _test.mintRoomSeqBatch("kobo", 1, deps)).toThrow();
  });

  test("mintRoomSeqBatch throws when the counter file is missing its seq field instead of silently resetting to 0", () => {
    const deps = { existsSync: () => true, readFileSync: () => JSON.stringify({}), writeFileSync: () => {}, renameSync: () => {}, mkdirSync: () => {} };
    expect(() => _test.mintRoomSeqBatch("kobo", 1, deps)).toThrow();
  });

  // kobo-415 lead ruling — mint-time detection cannot PREVENT the cross-process race
  // (two readers of the same starting count each look valid from where they stand), but
  // it CAN catch a narrower case: the counter not reading back as what THIS call just
  // wrote, meaning a third writer's rename or a rollback landed inside the write window.
  // Induced directly (a real two-process repro would be flaky/slow); this is the
  // observable symptom rather than the mechanism, same shape the merge test used for
  // eq3's binding AC.
  test("mintRoomSeqBatch throws when its own post-write read-back does not match — induced race/rollback in the write window", () => {
    let calls = 0;
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        calls++;
        // 1st read (before our write): counter=5, our range is based on this.
        // 2nd read (right after our write/rename): counter=9 — as if another writer's
        // rename landed in the gap between our write and this read-back.
        return JSON.stringify({ seq: calls === 1 ? 5 : 9 });
      },
      writeFileSync: () => {},
      renameSync: () => {},
      mkdirSync: () => {},
    };
    expect(() => _test.mintRoomSeqBatch("kobo", 3, deps)).toThrow();
  });

  // conductor's pre-empt check: can the post-write verify spuriously throw on a HEALTHY
  // sequence — e.g. one operation backfilling several rooms, or several appends in one
  // request? No: mintRoomSeqBatch has zero `await` from its first read to its own
  // post-write verify, so nothing else in the same process (including a second call to
  // this same function) can run in that window — a later call can't start until the
  // earlier one has already returned and passed its own check. Each call's verify only
  // ever observes its own write. Empirical, not just reasoned: real fs, no deps, multiple
  // rooms interleaved in one synchronous sequence.
  test("sequential mint calls across multiple rooms/appends in one operation never spuriously throw", () => {
    openRoom("kobo", "seqA", "a");
    openRoom("kobo", "seqB", "b");
    openRoom("kobo", "seqC", "c");
    expect(() => {
      appendRoomMessage("kobo", "seqA", { id: "a1", from: "x", text: "x", ts: 1 });
      appendRoomMessage("kobo", "seqB", { id: "b1", from: "x", text: "x", ts: 1 });
      appendRoomMessage("kobo", "seqC", { id: "c1", from: "x", text: "x", ts: 1 });
      appendRoomMessage("kobo", "seqA", { id: "a2", from: "x", text: "x", ts: 2 });
    }).not.toThrow();
  });

  test("backfilling multiple legacy rooms in sequence never spuriously throws", () => {
    for (const id of ["legA", "legB", "legC"]) {
      openRoom("kobo", id, id);
      const raw = JSON.parse(readFileSync(roomFilePath("kobo", id), "utf8"));
      raw.messages = Array.from({ length: 50 }, (_, i) => ({ id: `${id}-${i}`, from: "a", text: "x", ts: i }));
      writeFileSync(roomFilePath("kobo", id), JSON.stringify(raw));
    }
    expect(() => {
      readRoom("kobo", "legA");
      readRoom("kobo", "legB");
      readRoom("kobo", "legC");
    }).not.toThrow();
  });
});

// kobo-430 — the card's binding AC, and the reviewer's own measurement on PR #317's sha:
// 2 processes writing the SAME room concurrently, 40 messages each, 40/80 lost, counter
// stalled at 66 after 80 mints. Cause: appendRoomMessage's read-modify-write was
// last-writer-wins with no lock anywhere. Card explicitly forbids photographing today's
// single-process behaviour and calling it a test — a same-process simulation cannot
// reproduce this (JS run-to-completion already proven immune, see kobo-415's own
// sequential-mint tests), so this uses REAL separate OS processes, same measurement
// technique the reviewer used.
describe("appendRoomMessage concurrency (kobo-430 — real cross-process writers)", () => {
  let dir: string;
  const prevDataDir = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-room-concurrency-")); process.env.MAW_DATA_DIR = dir; });
  afterEach(() => { if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir; rmSync(dir, { recursive: true, force: true }); });

  test("two real OS processes appending 40 messages each to the SAME room concurrently — all 80 messages present, none lost, after both finish", async () => {
    openRoom("kobo", "concurrent-room", "topic");
    const fixture = new URL("./__fixtures__/append-worker.ts", import.meta.url).pathname;
    const env = { ...process.env, MAW_TEST_MODE: "1" };

    const t0 = performance.now();
    const procA = Bun.spawn(["bun", "run", fixture, "kobo", "concurrent-room", "A", "40"], { env, stderr: "pipe" });
    const procB = Bun.spawn(["bun", "run", fixture, "kobo", "concurrent-room", "B", "40"], { env, stderr: "pipe" });
    const [exitA, exitB] = await Promise.all([procA.exited, procB.exited]);
    const elapsed = performance.now() - t0;
    if (exitA !== 0) throw new Error(`worker A failed: ${await new Response(procA.stderr).text()}`);
    if (exitB !== 0) throw new Error(`worker B failed: ${await new Response(procB.stderr).text()}`);

    const room = readRoom("kobo", "concurrent-room")!;
    const ids = new Set(room.messages.map((m) => m.id));
    // AC: every message from BOTH sides present — the exact clause, not a proxy for it.
    expect(room.messages.length).toBe(80);
    expect(ids.size).toBe(80); // no id silently overwritten either
    for (let i = 0; i < 40; i++) { expect(ids.has(`A-${i}`)).toBe(true); expect(ids.has(`B-${i}`)).toBe(true); }
    // ORDER: each writer's OWN sequence must survive in its own relative order (cross-writer
    // interleaving is legitimately non-deterministic under true concurrency — that's not the
    // invariant here; a writer's messages arriving out of order relative to ITSELF would be).
    const aOrder = room.messages.filter((m) => m.id.startsWith("A-")).map((m) => m.id);
    const bOrder = room.messages.filter((m) => m.id.startsWith("B-")).map((m) => m.id);
    expect(aOrder).toEqual(Array.from({ length: 40 }, (_, i) => `A-${i}`));
    expect(bOrder).toEqual(Array.from({ length: 40 }, (_, i) => `B-${i}`));
    // CLEANUP: no stale .lock file left behind after a normal run — dropping the `finally`
    // unlink would leave this behind and every SUBSEQUENT append would find a lock file that
    // no live process holds (self-healing via the stale-pid check, but silently, not free).
    expect(existsSync(`${roomFilePath("kobo", "concurrent-room")}.lock`)).toBe(false);
    console.log(`kobo-430: 2 concurrent OS processes, 80 total appends, wall time ${elapsed.toFixed(0)}ms (lock-contention cost, room-file-scoped only)`);
  }, 20_000);

  // reviewer's step-1b finding: the "room-file-scoped, not global" claim (asserted in a code
  // comment AND printed in the test above) had NO guard. He mutated the lock key to a single
  // constant string (every room shares one lockfile) and the suite went 27/0 — nothing
  // noticed. Structural presence/count assertions can't distinguish per-room from global (a
  // global lock still delivers all 80 messages, just serialized) — the discriminator has to
  // be that contention on ONE room's lock does not delay a DIFFERENT room's write. A generous
  // but still tight timing gap (hold room A for 600ms, room B must finish in well under that)
  // is the correct signal here, not a proxy for it: this IS what "independent lock resource"
  // means operationally, and there's no non-timing way to observe two mutexes are unrelated.
  test("the lock is scoped PER ROOM FILE, not global — a held lock on one room does not block a write to a DIFFERENT room", async () => {
    openRoom("kobo", "roomA", "a");
    openRoom("kobo", "roomB", "b");
    const holdFixture = new URL("./__fixtures__/hold-lock-worker.ts", import.meta.url).pathname;
    const sentinel = join(dir, "holder-acquired");
    const env = { ...process.env, MAW_TEST_MODE: "1" };
    const holder = Bun.spawn(["bun", "run", holdFixture, "kobo", "roomA", "600", sentinel], { env, stderr: "pipe" });
    // wait for the holder to SIGNAL it has actually acquired the lock — not a fixed sleep
    // guessing at subprocess startup time. A guessed delay races the guess, not the scope
    // (caught this directly: an earlier fixed-150ms version let a real per-company-scope
    // mutation slip through once out of several runs, because the holder hadn't acquired
    // yet when the main test's append ran ahead of it).
    const pollDeadline = Date.now() + 5000;
    while (!existsSync(sentinel)) {
      if (Date.now() > pollDeadline) throw new Error("holder never signalled lock acquisition");
      await new Promise((r) => setTimeout(r, 5));
    }

    const t0 = performance.now();
    appendRoomMessage("kobo", "roomB", { id: "b1", from: "x", text: "y", ts: 1 });
    const elapsed = performance.now() - t0;

    const holderExit = await holder.exited;
    if (holderExit !== 0) throw new Error(`holder failed: ${await new Response(holder.stderr).text()}`);
    expect(readRoom("kobo", "roomB")!.messages).toHaveLength(1); // the write actually happened
    expect(elapsed).toBeLessThan(200); // a global (or per-company) lock would force this to wait out room A's 600ms hold
  }, 10_000);
});
