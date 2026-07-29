/**
 * duplicate-scope-warn — kobo-608: warn (never block) at card-creation time when
 * a new card's scope looks like it overlaps an OPEN card that already exists.
 *
 * Board Truth's own diagnosis (the card's evidence section): everyone who opened
 * a duplicate this session already knew the rule "check before you open" — the
 * rule failed because checking means reading ~500 open titles by eye, and the
 * fastest known real pair (kobo-588/kobo-589) was 6 minutes apart. "Be more
 * careful" cannot fix a check that's too slow for a human to run in time; this
 * is a machine check instead.
 *
 * DECLARED UNIVERSE (same discipline as kobo-597's `knownSenderOracles`, and
 * for the identical reason: state what the detector CAN see, so a miss reads as
 * "outside the universe" instead of "the detector is broken"):
 *
 *   - STRUCTURAL: two open cards that share a `parentIds` entry or the same
 *     `epic` are flagged. Cheap, exact, no threshold, deterministic — catches
 *     two cells landing the same finding under the same parent (kobo-524/
 *     kobo-564, both filed under kobo-525) even when their title wording has
 *     nothing in common at all.
 *   - LEXICAL: title+body character-trigram Jaccard similarity — works the
 *     same on Thai (no whitespace word boundaries) and English/code-identifier
 *     text without a tokenizer. Catches a same-topic pair phrased with
 *     genuinely overlapping vocabulary (kobo-548/kobo-569, kobo-588/kobo-589).
 *
 *   OUTSIDE the universe, by measurement, not by omission — TWO classes:
 *
 *   (1) CROSS-LANGUAGE: the detector compares trigrams of the same title+body
 *   window it always sees (see class (2) below) — a pair that's the SAME
 *   underlying issue described with one card leaning heavily Thai and the
 *   other leaning heavily English/technical-identifier will share only
 *   common/functional words in that window, regardless of content overlap.
 *   kobo-582/kobo-399 (one framed in Thai around cross-cell verdict delivery,
 *   one in English around cross-company ping leak — real bug-for-bug
 *   duplicate) measures 0.060: the only overlapping English tokens in kobo-
 *   582's own window are "card", "pane", "that", "tony" — purely functional
 *   words, not topic words. This is a SEMANTIC match, not a lexical one; no
 *   n-gram/token-overlap heuristic reaches it without an embedding model,
 *   deliberately out of scope (a card-creation-time check needs to stay cheap
 *   and synchronous). NOT a thai-only-vs-english-only label (a label misses
 *   most of the real class — a card that's 95% Thai and one that's 95%
 *   English are BOTH "mixed" under any coarse label, yet still miss each
 *   other): measured on the corpus's own trigram window (title+body[:500],
 *   the exact text the detector reads — head reviewer's independent
 *   measurement, kobo-608 card note c17, re-run there rather than trusting a
 *   number frozen in this comment; c11 published an earlier, WRONG number
 *   measured from title-only, retracted in c16/c17): of 514 cards, 172 (33%)
 *   have 0% Thai characters in that window and 175 (34%) have ≥50% Thai —
 *   a pair straddling those two ends is structurally invisible to this
 *   detector. Validated against 3 known-answer pairs (c18): kobo-582/kobo-399
 *   straddles the two ends and IS a known-miss; kobo-524/kobo-564 and kobo-
 *   548/kobo-569 both sit near the SAME end of the scale (not straddling) and
 *   are correctly caught/not-caught for OTHER reasons — confirms this class
 *   explains the one case we have ground truth for, without over-claiming
 *   coverage of cases we don't (3 pairs is context, not a sample size claim).
 *
 *   (2) OUTSIDE THE 500-CHARACTER WINDOW: `cardText()` below caps body at
 *   500 chars — a real, board-wide blind spot, not a rare edge (head
 *   reviewer's measurement, kobo-608 card note c20): 90.1% of cards have a
 *   body longer than 500 chars (median 1,617), so the detector's own working
 *   text is a truncated PREFIX for nearly every real card, and 75.1% of the
 *   corpus's total body content sits outside that prefix, unread by either
 *   signal. Concrete real miss: kobo-562's distinguishing content — the
 *   identifiers `parse-args` (char 974), `permissive` (char 1048),
 *   `positional` (char 1306) — sits entirely past the cap; a conductor nearly
 *   filed a duplicate of it and this detector would not have fired. Made
 *   worse by what IS inside the window: 64.9% of bodies carry this
 *   codebase's own story-template opener ("As a ..., I want ..., so that
 *   ...") inside the first 500 chars — so the visible window is disproportio-
 *   nately boilerplate every card shares, while the words that actually
 *   distinguish one card from another often live past it. Not fixed here
 *   (raising the cap is a real behavior change, not a doc fix — the 500-char
 *   choice itself was never re-examined against this data) — declared so a
 *   future miss reads as "known, bounded, tracked" rather than "silently
 *   broken".
 *
 *   Both classes are declared, honest residuals, not bugs to chase by
 *   loosening anything — see the threshold discipline note below for why
 *   "loosen it" is exactly the failure mode this card exists to close.
 *
 * THRESHOLD DESIGN — SELF-RELATIVE, NOT A BAKED-IN CONSTANT (round 2 of this
 * card's own design, reversing round 1): the first version fixed a single
 * numeric threshold from a frozen snapshot's negative-control distribution.
 * eq3's review caught the flaw in that approach directly: the candidate's
 * similarity SCORE against any one open card depends on how many OTHER open
 * cards exist (both the standard and, with the round-1 IDF weighting, the
 * score itself, move together as the corpus grows/shrinks) — so a threshold
 * frozen at one point in time is corpus-state baked into a constant, the EXACT
 * same anti-pattern kobo-597 ruled out for its fleet oracle-registry cache
 * (state that goes stale and nobody re-reads), just encoded as a number
 * instead of a file. The fix: at every card-creation event, compare the
 * candidate against however many open cards exist AT THAT MOMENT — a
 * comparison this function already has to do — then judge whether the TOP
 * score is an outlier RELATIVE TO THAT SAME BATCH'S OWN distribution (robust
 * z-score: `median + K * MAD`, median-absolute-deviation being the
 * outlier-resistant analogue of standard deviation), not against a number
 * chosen once and never revisited. This adapts automatically as the open-card
 * count changes; there is no state to go stale.
 *
 * `OUTLIER_K` and `OUTLIER_FLOOR` below are still fixed constants, but of a
 * different, disclosed kind: they scale a PER-EVENT statistic, not a raw
 * similarity score, so they don't encode "how similar is similar" for any
 * particular corpus size the way round 1's `0.1045` did. `OUTLIER_K` is the
 * standard "modified z-score" outlier convention (3.5/0.6745 ≈ 5.19,
 * Iglewicz & Hoaglin) — chosen from statistics literature, not tuned to this
 * card's own labeled examples (an earlier pass picked K=6 by scanning for a
 * value where a 2nd labeled pair started passing; caught in review and
 * reverted — see `OUTLIER_K`'s own doc comment for the full story; K=5 also
 * independently gives the same 2/3 recall, so the result holds across a real
 * range around the textbook value, not a knife-edge coincidence at one pick).
 * Measured (frozen 2026-07-29T01:11:13Z snapshot, 514 cards / 137 currently
 * open, kobo-608 card note has the reproducible script) against the 3-pair
 * labeled set + full negative control: this catches 2 of 3 labeled pairs
 * (kobo-548/kobo-569, kobo-588/kobo-589 — round 1's fixed-threshold design
 * caught only the first). Because the labeled set is only 3 pairs, recall can
 * only ever read 0%/33%/67%/100% — too coarse a scale to tell a genuinely
 * good mechanism from a lucky one; read it as "consistent with working", not
 * as a capability number.
 *
 * WARN-RATE — DENOMINATOR MUST BE STATED, NOT JUST THE PERCENT (review round
 * 1 finding, reviewer caught this reading two different questions as if they
 * were one): walking every one of the 514 cards in ts-order as if it were the
 * candidate at its own real creation moment, comparing only against cards
 * that already existed and were still open at that instant — the same
 * simulation this feature actually runs in production — **42/514 (8.2%) of
 * all card-creation events across this corpus's history would have received
 * ≥1 warning.** (An earlier draft of this comment quoted "27.0%" against a
 * denominator of "cards still open at snapshot time" (141, later corrected to
 * 137) — a different, less meaningful question: it answers "of what's open
 * right now, how much looks similar to something else also open right now",
 * not "how often would a person creating a card actually see this warning".
 * The two numbers are both real; only the second is what a user experiences.)
 * Of the 60 total warning-pairs in that sweep: 54 similar-text, 6 shared-
 * parent, 0 shared-epic.
 *
 * SHARED-EPIC FIRED ZERO TIMES ON REAL DATA — measured, not assumed (review
 * round 1 flagged this as suspicious and asked it be checked instead of
 * quietly left to read as if two structural signals were both active).
 * Reason, also measured: of 202 same-epic candidate-pairs in the corpus, 131
 * (65%) fall inside `BATCH_WINDOW_MS` (ordinary decompose siblings, created
 * seconds apart) — and of the 71 that survive the window, 100% have their
 * earlier sibling ALREADY CLOSED by the time the later one would be compared
 * against it — on this board, an epic's earlier children tend to reach a
 * closed state before a later, unrelated sibling gets added under the same
 * epic. Net: shared-epic is not broken, it is structurally near-unreachable
 * given how this board's epics are actually used day to day — kept because
 * it's cheap/exact/zero-cost-when-idle and the shape it exists for (kobo-524/
 * kobo-564, filed under the same still-open parent kobo-525) is real, just
 * currently rare.
 *
 * CREATOR-BASED RESTRICTION — MEASURED AND REJECTED (review round 2 raised
 * "should shared-parent/shared-epic only warn when `by` differs, since a
 * late add to an existing epic is usually the SAME person who did the
 * original decompose?"): checked against the one confirmed real duplicate —
 * kobo-524 and kobo-564 were BOTH created by `eq3`, same creator. All 6 of
 * the shared-parent pairs found in the real-corpus sweep above are also
 * same-creator pairs. Restricting to different-creator-only would have
 * missed the one real case this card has ground truth for. Not implemented.
 *
 * A manual spot-check of 8 of 38 flagged cards (an earlier, pre-batch-guard
 * sweep) found 4 read as genuinely sensible on inspection and 4 as noise.
 *
 * BATCH-DECOMPOSE FALSE-POSITIVE CLASS (found in that same spot-check, fixed
 * before shipping): 2 of the 4 "noise" flags were sibling cards from the SAME
 * epic decompose (kobo-417/kobo-420/kobo-416, all children of kobo-414,
 * created 0.096 SECONDS apart) — a legitimate task breakdown, not a mistake,
 * flagged only because siblings describing one feature naturally share
 * vocabulary. The real duplicate in the labeled set (kobo-524/kobo-564) was
 * created 14.8 HOURS apart — an enormous, clean separation from the
 * decompose-batch timing. `BATCH_WINDOW_MS` excludes an existing open card
 * from EITHER signal if it was created within that window of "now" (the
 * candidate's own creation moment) — this is NOT a full fix for lexical false
 * positives in general (a longer tail of genuinely-unrelated-but-worded-
 * similarly pairs remains, e.g. kobo-122/kobo-411 at 492 hours apart, no
 * batch relationship at all — a different, harder problem this card does not
 * claim to solve), but it measurably removes the ONE class this spot-check
 * could name precisely and explain. A card added LATER to an epic that
 * already has several open children is a separate, NOT-yet-fixed noise
 * shape (review round 2): the window only protects same-batch siblings, not
 * a sibling added afterward — see the shared-epic measurement above for why
 * this hasn't shown up on real data yet, and the note-cap in store.ts's
 * addTask() for the defensive mitigation (a long note is capped, not
 * suppressed) if/when it does.
 */

import type { TaskRecord, TaskState } from "./store";

const OPEN_STATES: ReadonlySet<TaskState> = new Set([
  "backlog", "todo", "ready", "in-progress", "review", "need-answer", "approve", "blocked",
]);

/** Character-trigram Jaccard needs no tokenizer — works the same on Thai (no
 *  whitespace word boundaries) and English/code-identifier text. Punctuation
 *  and markdown decoration are stripped so `**bold**`/`[brackets]`/`— dashes —`
 *  don't count as content similarity. */
function normalize(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[`*_#[\]()【】·—–\-:;,.!?"'/\\]/g, " ").replace(/\s+/g, " ").trim();
}

function trigrams(s: string | undefined): Set<string> {
  const norm = normalize(s);
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 2; i++) out.add(norm.slice(i, i + 3));
  return out;
}

function cardText(t: Pick<TaskRecord, "title" | "body">): string {
  return `${t.title} ${(t.body ?? "").slice(0, 500)}`; // body capped — a 500-char lead carries the topic; a 5000-word card shouldn't dominate the trigram vocabulary over a 50-word one. This is a measured, declared blind spot, not a free assumption — see module docstring's "OUTSIDE THE 500-CHARACTER WINDOW" class (90.1% of real cards exceed this cap; kobo-562 is a real miss caused by it)
}

function plainJaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * kobo-608: the raw title+body similarity between two cards — exported as its
 * own deterministic, fixture-independent function. This number does NOT
 * depend on any corpus/background at all (unlike the outlier judgment below),
 * so it's the right thing to pin directly in tests, and the right thing to
 * quote in a bug report/measurement script without needing to reconstruct a
 * whole corpus around it.
 */
export function titleBodySimilarity(a: { title: string; body?: string }, b: { title: string; body?: string }): number {
  return plainJaccard(trigrams(cardText(a)), trigrams(cardText(b)));
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Median Absolute Deviation — the outlier-resistant analogue of standard
 *  deviation (a single far-outlier can't drag it around the way it drags a
 *  mean/stdev, which matters here since a REAL duplicate is itself expected
 *  to be that one outlier). */
function mad(values: number[], med: number): number {
  const deviations = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return median(deviations);
}

/**
 * kobo-608: the outlier judgment as its own deterministic, corpus-shape-
 * independent function — given a candidate score and the OTHER scores it's
 * being compared against (already computed elsewhere), decide whether the
 * candidate stands out via `score > median(others) + K * MAD(others)`
 * (floored). Exported so this decision rule can be pinned directly against a
 * hand-written array of numbers in tests, with no dependency on trigrams,
 * card text, or any particular corpus's noise shape.
 */
export function isSimilarityOutlier(score: number, otherScores: number[], k = OUTLIER_K, floor = OUTLIER_FLOOR): boolean {
  if (!otherScores.length) return false;
  const sorted = [...otherScores].sort((a, b) => a - b);
  const med = median(sorted);
  const cutoff = Math.max(med + k * mad(sorted, med), floor);
  return score > cutoff;
}

/**
 * kobo-608: how many MADs above the batch's own median counts as "stands out".
 * `3.5 / 0.6745` is the standard "modified z-score" outlier convention
 * (Iglewicz & Hoaglin) — chosen from statistics literature, NOT by scanning
 * this card's own labeled examples for a value that makes them pass (an
 * earlier pass of this exact constant WAS picked that way — K=6, because it
 * was where a 2nd labeled pair started passing — caught in review and
 * reverted; the textbook value below independently gives the same 2/3 recall
 * on re-measurement, which is what makes it trustworthy, not the recall
 * number by itself). See the module docstring's threshold-design section.
 */
export const OUTLIER_K = 3.5 / 0.6745;
/**
 * Floor on the raw cutoff (median + K*MAD), in absolute Jaccard-score terms —
 * guards the degenerate case where an open-card batch is small/near-identical
 * enough that median and MAD both collapse toward 0 (K*MAD stays ~0 too,
 * which would flag near-everything as an "outlier" relative to a distribution
 * that has almost no spread to begin with). Measured: this floor never
 * actually bound in the 141-card frozen-snapshot measurement — it's a safety
 * net for a batch shape that snapshot didn't happen to contain, not a tuned
 * parameter.
 */
export const OUTLIER_FLOOR = 0.03;

/**
 * kobo-608: an existing open card created within this window of "now" is
 * treated as part of the SAME batch-creation action as the candidate (a
 * decompose, a multi-child dispatch) rather than an independently-opened
 * possible duplicate — see the module docstring's "batch-decompose
 * false-positive class" note for the measured 0.096s-vs-14.8h separation
 * that justifies this. 5 minutes is generous headroom above the measured
 * same-batch case (well under 1 second) while staying well below the
 * measured real-duplicate case (hours) — not tuned to a labeled example,
 * there is no labeled example anywhere near this boundary either way.
 */
export const BATCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * kobo-608: the batch-window decision as its own deterministic, one-line
 * function — given two creation timestamps, is `existingTs` "too recent"
 * relative to `nowTs` to be an independent duplicate rather than a same-batch
 * sibling? Exported so this can be pinned directly against hand-written
 * timestamps in tests (the measured 0.096s-vs-14.8h gap that justifies
 * `BATCH_WINDOW_MS`), with no dependency on card text or corpus shape at all.
 */
export function isWithinBatchWindow(existingTs: number, nowTs: number, windowMs = BATCH_WINDOW_MS): boolean {
  return nowTs - existingTs < windowMs;
}

export interface ScopeOverlapWarning {
  id: string;
  title: string;
  reason: "shared-parent" | "shared-epic" | "similar-text";
  score?: number; // present only for "similar-text" — the raw Jaccard score, not a z-score
}

/**
 * Compare a candidate new card (title/body/parentIds/epic, not yet created —
 * this never mutates anything, never blocks) against every OPEN card in the
 * same company. Returns warnings sorted strongest-first; empty = nothing
 * flagged. Callers decide what to do with a non-empty result (kobo-608's own
 * AC: warn, never block — creation must still be possible after a warning).
 *
 * `listTasks` is a REQUIRED dependency, not a default-imported one — this
 * module deliberately never imports from `./store` at the value level (only
 * `import type` above, erased at compile time): `store.ts`'s own `addTask`
 * is this function's main caller, so a value-level import back from here
 * would be a circular module dependency. The caller already has its own
 * `listTasks` in scope either way.
 */
export function findSimilarOpenCards(
  company: string,
  candidate: { title: string; body?: string; parentIds?: string[]; epic?: string },
  deps: { listTasks: (company: string) => TaskRecord[]; now?: number },
): ScopeOverlapWarning[] {
  const now = deps.now ?? Date.now();
  const open = deps.listTasks(company)
    .filter((t) => OPEN_STATES.has(t.state))
    // batch-decompose exclusion — see isWithinBatchWindow's own doc comment
    .filter((t) => !isWithinBatchWindow(t.ts, now));
  if (!open.length) return [];

  const warnings: ScopeOverlapWarning[] = [];
  const candidateParents = new Set(candidate.parentIds ?? []);

  // structural pass — exact, cheap, no threshold
  for (const t of open) {
    if (candidateParents.size && t.parentIds?.some((p) => candidateParents.has(p))) {
      warnings.push({ id: t.id, title: t.title, reason: "shared-parent" });
      continue; // a card only needs to be flagged once — structural already won
    }
    if (candidate.epic && t.epic && candidate.epic === t.epic) {
      warnings.push({ id: t.id, title: t.title, reason: "shared-epic" });
    }
  }

  // lexical pass — self-relative: this batch's own score distribution IS the
  // reference, not a constant fixed at some earlier corpus size (see the
  // module docstring's threshold-design section).
  const alreadyWarned = new Set(warnings.map((w) => w.id));
  const scored = open
    .filter((t) => !alreadyWarned.has(t.id)) // structural already flagged it — don't double-report
    .map((t) => ({ t, score: titleBodySimilarity(candidate, t) }));
  // ONE shared distribution for the whole batch (every candidate-vs-open-card
  // score computed this call), not a per-item leave-one-out — every score is
  // judged against the SAME cutoff, matching what was actually measured.
  const allScores = scored.map((s) => s.score);
  for (const { t, score } of scored) {
    if (isSimilarityOutlier(score, allScores)) warnings.push({ id: t.id, title: t.title, reason: "similar-text", score });
  }

  return warnings.sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
}
