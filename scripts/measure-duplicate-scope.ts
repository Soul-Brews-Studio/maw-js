#!/usr/bin/env bun
/**
 * measure-duplicate-scope.ts — kobo-608's reproducible measurement script.
 *
 * duplicate-scope-warn.ts's own docstring intentionally carries NO frozen
 * numbers. Reason (kobo-608 card note has the full history): every number
 * this feature has ever quoted in prose — a docstring, a card comment —
 * independently failed re-verification once, 3 times in a row, by 3
 * different people, none of them careless: measured the wrong text window,
 * measured on a commit that had already moved, or simply couldn't be
 * reproduced at all. On a board that grows continuously, a number frozen in
 * a comment reads as permanent fact nobody re-checks — the SAME failure
 * class as a frozen name-list (kobo-597's `knownSenderOracles` residual is
 * a rule + dated examples for the identical reason). This script is the
 * single source of truth for "what does this detector actually do on a real
 * corpus right now" — RUN it, don't trust a number typed into prose.
 *
 * Reuses the real exported detector functions (`findSimilarOpenCards`,
 * `isWithinBatchWindow`, `BATCH_WINDOW_MS`) rather than reimplementing the
 * algorithm — a re-implementation could silently drift from what actually
 * ships; this can't.
 *
 * Usage:
 *   bun scripts/measure-duplicate-scope.ts --tasks-dir <dir-of-task-json-files>
 *
 * Point --tasks-dir at a directory of per-card task JSON files — a frozen
 * snapshot copy (recommended: measurements are only comparable across a
 * FROZEN corpus, never a live/growing one — see kobo-597/kobo-608's own
 * "freeze before comparing" lesson) or, for a one-off live read, a
 * company's live tasks dir (e.g. `~/.maw/companies/<company>/tasks`).
 * Read-only — this script never writes anything.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  findSimilarOpenCards,
  isWithinBatchWindow,
  BATCH_WINDOW_MS,
  type ScopeOverlapWarning,
} from "../src/core/tasks/duplicate-scope-warn";
import type { TaskRecord, TaskState } from "../src/core/tasks/store";

const OPEN_STATES: ReadonlySet<TaskState> = new Set([
  "backlog", "todo", "ready", "in-progress", "review", "need-answer", "approve", "blocked",
]);

function parseArgs(argv: string[]): { tasksDir: string } {
  const idx = argv.indexOf("--tasks-dir");
  if (idx === -1 || !argv[idx + 1]) {
    console.error("usage: bun scripts/measure-duplicate-scope.ts --tasks-dir <dir>");
    process.exit(1);
  }
  return { tasksDir: argv[idx + 1] };
}

function loadTasks(dir: string): TaskRecord[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskRecord;
      } catch {
        return null;
      }
    })
    .filter((t): t is TaskRecord => t !== null);
}

// The exact window the detector reads (cardText() in duplicate-scope-warn.ts) —
// duplicated here ONLY for the diagnostic language/window analysis below, which
// is about corpus SHAPE, not detector behavior (that part goes through the real
// `findSimilarOpenCards` above, never reimplemented).
function windowText(t: TaskRecord): string {
  return `${t.title} ${(t.body ?? "").slice(0, 500)}`;
}

// Thai-character ratio among script characters (Thai + Latin letters) present
// in the detector's own window — NOT a thai/eng/mixed label (kobo-608 c17: a
// coarse label puts a 95%-Thai card and a 95%-English card in the same
// "mixed" bucket, hiding the exact class that matters).
function thaiRatio(s: string): number {
  const thai = (s.match(/[฀-๿]/g) ?? []).length;
  const letters = (s.match(/[฀-๿a-zA-Z]/g) ?? []).length;
  return letters ? thai / letters : 0;
}

function main() {
  const { tasksDir } = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(tasksDir);
  const openNow = tasks.filter((t) => OPEN_STATES.has(t.state));

  console.log(`snapshot dir: ${tasksDir}`);
  console.log(`measured at: ${new Date().toISOString()}`);
  console.log(`total cards: ${tasks.length}`);
  console.log(`currently open: ${openNow.length}`);
  console.log();

  // Sequential/historical simulation — the real-world question: walk every
  // card in creation order, comparing it (as if brand new) only against
  // cards that already existed and were still open at that moment. Real
  // "now" = the candidate's own creation ts, exactly what addTask() does.
  const sorted = [...tasks].sort((a, b) => a.ts - b.ts);
  let warnedCount = 0;
  const byReason: Record<ScopeOverlapWarning["reason"], number> = {
    "shared-parent": 0,
    "shared-epic": 0,
    "similar-text": 0,
  };
  for (let i = 0; i < sorted.length; i++) {
    const cand = sorted[i];
    const priorOpen = sorted.slice(0, i).filter((t) => OPEN_STATES.has(t.state));
    const warns = findSimilarOpenCards(
      "measured",
      { title: cand.title, body: cand.body, parentIds: cand.parentIds, epic: cand.epic },
      { listTasks: () => priorOpen, now: cand.ts },
    );
    if (warns.length) warnedCount++;
    for (const w of warns) byReason[w.reason]++;
  }
  const warnRate = tasks.length ? (100 * warnedCount) / tasks.length : 0;
  console.log(
    `warn-rate (sequential, real creation-time simulation — the question a real user actually experiences): ${warnedCount}/${tasks.length} = ${warnRate.toFixed(1)}%`,
  );
  console.log(
    `by reason: shared-parent=${byReason["shared-parent"]} shared-epic=${byReason["shared-epic"]} similar-text=${byReason["similar-text"]}`,
  );
  console.log();

  // shared-epic reachability — how much BATCH_WINDOW_MS eats it, and of what
  // survives, how much never reaches an OPEN earlier sibling to compare against.
  const byEpic = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    if (!t.epic) continue;
    const arr = byEpic.get(t.epic) ?? [];
    arr.push(t);
    byEpic.set(t.epic, arr);
  }
  let totalEpicPairs = 0;
  let excludedByWindow = 0;
  let survivingWithEarlierStillOpen = 0;
  for (const kids of byEpic.values()) {
    const sortedKids = [...kids].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sortedKids.length; i++) {
      for (let j = 0; j < i; j++) {
        totalEpicPairs++;
        if (isWithinBatchWindow(sortedKids[j].ts, sortedKids[i].ts)) {
          excludedByWindow++;
        } else if (OPEN_STATES.has(sortedKids[j].state)) {
          survivingWithEarlierStillOpen++;
        }
      }
    }
  }
  console.log(
    `shared-epic candidate pairs: ${totalEpicPairs}, excluded by BATCH_WINDOW_MS (${BATCH_WINDOW_MS / 60000}min): ${excludedByWindow}, surviving with earlier sibling still open (reachable by the signal): ${survivingWithEarlierStillOpen}`,
  );
  console.log();

  // language window — measured on the SAME text the detector reads (title + body[:500]).
  let zeroThai = 0;
  let majorityThai = 0;
  for (const t of tasks) {
    const r = thaiRatio(windowText(t));
    if (r === 0) zeroThai++;
    if (r >= 0.5) majorityThai++;
  }
  console.log(
    `language window (title+body[:500], the text the detector reads): 0% Thai = ${zeroThai}/${tasks.length}, >=50% Thai = ${majorityThai}/${tasks.length}`,
  );
  console.log();

  // 500-char window coverage.
  const bodyLens = tasks.map((t) => (t.body ?? "").length).sort((a, b) => a - b);
  const over500 = bodyLens.filter((l) => l > 500).length;
  const medianLen = bodyLens.length ? bodyLens[Math.floor(bodyLens.length / 2)] : 0;
  const totalChars = bodyLens.reduce((a, b) => a + b, 0);
  const visibleChars = tasks.reduce((sum, t) => sum + Math.min((t.body ?? "").length, 500), 0);
  const outsidePct = totalChars ? (100 * (totalChars - visibleChars)) / totalChars : 0;
  const storyTemplateRe = /\*\*As a\*\*|As a .{0,80}, I want/i;
  const withStoryTemplateInWindow = tasks.filter((t) => storyTemplateRe.test((t.body ?? "").slice(0, 500))).length;
  console.log(
    `body > 500 chars: ${over500}/${tasks.length} (${((100 * over500) / tasks.length).toFixed(1)}%), median body length: ${medianLen}`,
  );
  console.log(`corpus content sitting outside the 500-char window: ${outsidePct.toFixed(1)}%`);
  // A card with NO body structurally cannot contain the story-template opener —
  // not a rare miss, a logical impossibility (kobo-608 round 6, head reviewer):
  // counting it in the denominator understates the rate among cards that could
  // actually carry it. Print the denominator that can actually answer the
  // question, named, plus what that count is as a share of every card — the
  // reader picks which question they want, never guesses which one a bare
  // fraction answers.
  const cardsWithBody = tasks.filter((t) => (t.body ?? "").length > 0).length;
  console.log(
    `cards whose VISIBLE window carries the story-template opener: ${withStoryTemplateInWindow}/${cardsWithBody} cards-with-body (${cardsWithBody ? ((100 * withStoryTemplateInWindow) / cardsWithBody).toFixed(1) : "0.0"}%) — of all ${tasks.length} cards that's ${((100 * withStoryTemplateInWindow) / tasks.length).toFixed(1)}%`,
  );
}

main();
