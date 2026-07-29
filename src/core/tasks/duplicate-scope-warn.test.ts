import { describe, expect, test } from "bun:test";
import {
  findSimilarOpenCards, titleBodySimilarity, isSimilarityOutlier, isWithinBatchWindow,
  OUTLIER_K, OUTLIER_FLOOR, BATCH_WINDOW_MS,
} from "./duplicate-scope-warn";
import type { TaskRecord } from "./store";

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, "id" | "title">): TaskRecord {
  return {
    company: "kobo", state: "todo", by: "eq3", assignee: null, ts: 0, updatedTs: 0,
    ...overrides,
  } as TaskRecord;
}

// kobo-608 — DESIGN NOTE (why this file is split the way it is): an earlier
// pass of this file tried to assert end-to-end RECALL (does the detector
// catch the real labeled pairs) against a hand-built SYNTHETIC background
// corpus. That corpus's own noise shape doesn't match the real board's
// organic text, so the same raw score landed on different sides of the
// outlier line depending on which fixture measured it — a test asserting
// "kobo-582/kobo-399 is/isn't caught" would have been read as a spec by a
// future reader, when the true answer depends on data this file can't
// faithfully reproduce. Recall/warn-rate are corpus-shape-dependent
// MEASUREMENTS, not corpus-shape-independent LOGIC — the two must not be
// mixed the same way kobo-597 learned not to sum a title-only and a
// title+body measurement into one recall number (the "130 vs 127" mistake).
//
// So: this file pins the three DETERMINISTIC, corpus-shape-independent
// building blocks directly (raw similarity, the outlier decision rule fed a
// literal array, and the batch-window decision fed literal timestamps) —
// each one is a pure function with no dependency on any particular corpus.
// The actual RECALL and WARN-RATE numbers this card's AC is measured against
// come from a script run against the real, frozen 2026-07-29T01:11:13Z kobo
// task-store snapshot (137 open cards) — reproducible, documented in the
// module docstring and the kobo-608 card note/PR body, never asserted as a
// unit-test expectation here.

describe("titleBodySimilarity — raw score, deterministic, no corpus dependency", () => {
  // Real point-in-time text, recovered from each card's own edit-history
  // ("previous values preserved") notes where retitled after the fact — see
  // the kobo-608 card note for the full recovery trail. These are the exact
  // 3 raw scores measured and reported for this card's real recall number.
  test("kobo-548 <-> kobo-569 — same topic, overlapping vocabulary: 0.186", () => {
    const a = { title: "คิวตัดสินใจของ Tony มองเห็นได้บนบอร์ด — เลน need-answer ถูก render" };
    const b = { title: "lane need-answer ไม่อยู่ใน TASK_FLOW — คิว decision ของ Tony มองไม่เห็นบน CLI ทั้งที่ข้อมูลมีครบ" };
    expect(titleBodySimilarity(a, b)).toBeCloseTo(0.186, 2);
  });

  test("kobo-588 <-> kobo-589 — same underlying bug (room.ts guard vs measured behavior): 0.107", () => {
    const a = { title: "แก้คำอธิบายใน room.ts ที่ผลวัดค้าน — guard ถูก แต่เหตุผลที่เขียนกำกับไว้ไม่จริง" };
    const b = { title: "คอมเมนต์เหนือ guard room.ts:537 อ้างว่ากันคำขอเครือข่าย — วัดแล้วไม่มีคำขอนั้น (แก้รอบ 3)" };
    expect(titleBodySimilarity(a, b)).toBeCloseTo(0.107, 2);
  });

  test("kobo-582 <-> kobo-399 — same bug, different language/framing entirely: 0.068 (the declared semantic-not-lexical residual)", () => {
    const a = {
      title: "สืบ: hey ไปโผล่ผิด pane ข้ามเซลล์ — ผู้ส่งจ่าหน้า pane หนึ่ง ผู้รับเป็นอีก pane คนละ session",
      body: "As a คนที่ส่ง verdict/hold/brief ข้ามเซลล์, I want รู้ว่าข้อความถึงคนที่จ่าหน้าไว้จริง, so that คำสั่งที่ ส่งแล้ว ไม่ไปนั่งอยู่ในหัวคนอื่นโดยไม่มีใครรู้ Card A สืบอย่างเดียว ห้ามแก้ audit log pane oracle delivery cross-cell",
    };
    const b = {
      title: "Investigate: cross-company ping leak — kobo card-ping reached sapan (pgw-only oracle, not in kobo roster)",
      body: "READ-ONLY INVESTIGATE NO fix Tony-gate after finding. a ping forward for kobo-398 surfaced at pane sapan pgw driver-lead NOT in the kobo roster at all. Which path carries a kobo card-ping to an oracle that isn't a member of that company",
    };
    expect(titleBodySimilarity(a, b)).toBeCloseTo(0.068, 2);
  });

  test("identical text scores 1.0; completely disjoint text scores 0", () => {
    expect(titleBodySimilarity({ title: "exact same title" }, { title: "exact same title" })).toBe(1);
    expect(titleBodySimilarity({ title: "abc" }, { title: "xyz" })).toBe(0);
  });
});

describe("isSimilarityOutlier — the decision rule, fed a literal array (no trigrams, no corpus)", () => {
  test("a score far above a tight, low-spread distribution is an outlier", () => {
    // 9 near-identical low scores (median~0.02, tiny spread) + 1 clear outlier
    const others = [0.01, 0.02, 0.02, 0.02, 0.03, 0.02, 0.01, 0.02, 0.02];
    expect(isSimilarityOutlier(0.5, others)).toBe(true);
  });

  test("a score within a wide, noisy distribution's normal range is NOT an outlier", () => {
    const others = [0.05, 0.15, 0.25, 0.1, 0.3, 0.08, 0.22, 0.18, 0.12];
    expect(isSimilarityOutlier(0.2, others)).toBe(false); // well within the range these numbers already span
  });

  test("OUTLIER_FLOOR guards the degenerate case: a near-zero-spread distribution doesn't flag every tiny score as an outlier", () => {
    const allZero = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(isSimilarityOutlier(0.02, allZero)).toBe(false); // below the floor, even though median+K*MAD is ~0
    expect(isSimilarityOutlier(0.04, allZero)).toBe(true); // above the floor
  });

  test("no other scores at all — never an outlier (nothing to compare against)", () => {
    expect(isSimilarityOutlier(0.9, [])).toBe(false);
  });

  test("exactly at the cutoff is NOT an outlier — strictly greater-than, not greater-or-equal", () => {
    const others = [0.1, 0.1, 0.1, 0.1, 0.1];
    const cutoff = Math.max(0.1 + OUTLIER_K * 0, OUTLIER_FLOOR); // median=0.1, MAD=0 here, so cutoff = max(0.1, OUTLIER_FLOOR)
    expect(isSimilarityOutlier(cutoff, others)).toBe(false);
    expect(isSimilarityOutlier(cutoff + 0.0001, others)).toBe(true);
  });

  // Honesty pin: OUTLIER_K must be the textbook modified-z-score convention,
  // not a value hand-picked by scanning this card's own labeled examples for
  // one that makes a specific pair pass — an earlier pass of this exact
  // constant WAS picked that way (K=6, caught in review, reverted).
  test("OUTLIER_K is the textbook modified-z-score convention (3.5/0.6745 ≈ 5.19), not a hand-picked value", () => {
    expect(OUTLIER_K).toBeCloseTo(3.5 / 0.6745, 6);
  });

  test("OUTLIER_FLOOR is a small positive safety net, not a value large enough to be doing the real work by itself", () => {
    expect(OUTLIER_FLOOR).toBeGreaterThan(0);
    expect(OUTLIER_FLOOR).toBeLessThan(0.1);
  });
});

describe("isWithinBatchWindow — batch-decompose exclusion, fed literal timestamps (no trigrams, no corpus)", () => {
  // kobo-608: found via a spot-check of real flagged pairs — kobo-417/
  // kobo-420/kobo-416 (siblings under epic kobo-414) were created 0.096
  // SECONDS apart (a legitimate decompose, not a mistake), while the real
  // labeled duplicate kobo-524/kobo-564 was created 14.8 HOURS apart. These
  // two exact measured gaps are pinned directly below — the whole reason
  // BATCH_WINDOW_MS (5 minutes) exists sits squarely between them, with
  // generous headroom on both sides, not tuned to either boundary.
  const REAL_SIBLING_GAP_MS = 0.096 * 1000;
  const REAL_DUPLICATE_GAP_MS = 14.8 * 3600 * 1000;

  test("the measured same-batch sibling gap (0.096s) IS within the window", () => {
    expect(isWithinBatchWindow(1_000_000 - REAL_SIBLING_GAP_MS, 1_000_000)).toBe(true);
  });

  test("the measured real-duplicate gap (14.8h) is NOT within the window", () => {
    expect(isWithinBatchWindow(1_000_000_000 - REAL_DUPLICATE_GAP_MS, 1_000_000_000)).toBe(false);
  });

  test("exactly at the window boundary is NOT within the window — strictly less-than, not less-or-equal", () => {
    expect(isWithinBatchWindow(1_000_000 - BATCH_WINDOW_MS, 1_000_000)).toBe(false);
    expect(isWithinBatchWindow(1_000_000 - BATCH_WINDOW_MS + 1, 1_000_000)).toBe(true);
  });

  test("BATCH_WINDOW_MS sits with real headroom on both sides of the measured gap, not tuned to either boundary", () => {
    expect(BATCH_WINDOW_MS).toBeGreaterThan(REAL_SIBLING_GAP_MS * 100); // orders of magnitude above the sibling case
    expect(BATCH_WINDOW_MS).toBeLessThan(REAL_DUPLICATE_GAP_MS / 100); // orders of magnitude below the duplicate case
  });
});

// kobo-608 — integration tests: exercise findSimilarOpenCards end-to-end
// through a small, fully-controlled, hand-built scenario (not a corpus meant
// to resemble the real board) — these pin the WIRING between the structural
// pass, the lexical pass, and the batch-window filter, not any recall number.
describe("findSimilarOpenCards — wiring (structural + lexical + batch-window), small controlled scenarios", () => {
  test("shared parentIds fires the structural signal, independent of text similarity", () => {
    const existing = task({ id: "kobo-1", title: "completely unrelated wording", parentIds: ["kobo-parent"] });
    const candidate = { title: "totally different wording too", parentIds: ["kobo-parent"] };
    const warnings = findSimilarOpenCards("kobo", candidate, { listTasks: () => [existing] });
    expect(warnings).toEqual([{ id: "kobo-1", title: "completely unrelated wording", reason: "shared-parent" }]);
  });

  test("shared epic (not just parentIds) also fires the structural signal", () => {
    const existing = task({ id: "kobo-1", title: "unrelated wording entirely", epic: "kobo-epic-1" });
    const candidate = { title: "completely different wording too", epic: "kobo-epic-1" };
    const warnings = findSimilarOpenCards("kobo", candidate, { listTasks: () => [existing] });
    expect(warnings).toEqual([{ id: "kobo-1", title: "unrelated wording entirely", reason: "shared-epic" }]);
  });

  test("a card is never flagged twice — structural match short-circuits the lexical pass for the same id", () => {
    const existing = task({ id: "kobo-1", title: "identical wording on purpose", parentIds: ["kobo-parent"] });
    const candidate = { title: "identical wording on purpose", parentIds: ["kobo-parent"] }; // would ALSO win lexically
    const warnings = findSimilarOpenCards("kobo", candidate, { listTasks: () => [existing] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe("shared-parent"); // structural wins, no duplicate lexical entry
  });

  test("a card in a non-open state (done/rejected) is never compared at all, even with identical text", () => {
    const existing = task({ id: "kobo-1", state: "done", title: "identical wording either way" });
    const candidate = { title: "identical wording either way" };
    expect(findSimilarOpenCards("kobo", candidate, { listTasks: () => [existing] })).toEqual([]);
  });

  test("a card created within the batch window is excluded from BOTH signals, even with a shared parent and identical text", () => {
    const now = 2_000_000;
    const justCreated = task({ id: "kobo-1", title: "identical wording either way", parentIds: ["kobo-parent"], ts: now - 1000 });
    const candidate = { title: "identical wording either way", parentIds: ["kobo-parent"] };
    const warnings = findSimilarOpenCards("kobo", candidate, { listTasks: () => [justCreated], now });
    expect(warnings).toEqual([]);
  });

  test("the identical scenario, but the existing card is OLD (outside the batch window) — DOES get flagged via shared-parent", () => {
    const now = 2_000_000;
    const old = task({ id: "kobo-1", title: "identical wording either way", parentIds: ["kobo-parent"], ts: now - BATCH_WINDOW_MS - 1 });
    const candidate = { title: "identical wording either way", parentIds: ["kobo-parent"] };
    const warnings = findSimilarOpenCards("kobo", candidate, { listTasks: () => [old], now });
    expect(warnings).toEqual([{ id: "kobo-1", title: "identical wording either way", reason: "shared-parent" }]);
  });

  test("no open cards at all — returns empty, no crash", () => {
    expect(findSimilarOpenCards("kobo", { title: "first card ever" }, { listTasks: () => [] })).toEqual([]);
  });

  test("warn, never block — the function only returns data, it never throws or refuses", () => {
    const many = Array.from({ length: 20 }, (_, i) => task({ id: `kobo-${i}`, title: `some card about topic ${i}` }));
    expect(() => findSimilarOpenCards("kobo", { title: "yet another card" }, { listTasks: () => many })).not.toThrow();
  });

  test("a clear lexical outlier among a low-similarity background IS flagged, with the real raw score attached", () => {
    const background = Array.from({ length: 15 }, (_, i) => task({ id: `kobo-bg-${i}`, title: `unrelated background card number ${i} about something else entirely` }));
    const nearDuplicate = task({ id: "kobo-target", title: "แก้ backslash ที่ถูก template literal กลืน + ด่านอัตโนมัติกันทั้งคลาส" });
    const candidate = { title: "แก้ backslash ที่ถูก template literal กลืน + ด่านอัตโนมัติกันทั้งคลาส (ซอร์สถูก ของที่เสิร์ฟผิด)" };
    const warnings = findSimilarOpenCards("kobo", candidate, { listTasks: () => [nearDuplicate, ...background] });
    const forTarget = warnings.find((w) => w.id === "kobo-target");
    expect(forTarget?.reason).toBe("similar-text");
    expect(forTarget?.score).toBeGreaterThan(0.5); // near-identical text — high raw score, not just "flagged"
  });
});
