import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";

// #2316 plugin-coverage-gate: the task board engine lives in src/core/tasks/* +
// the worklog company-scope helper. The `task` plugin is the thin CLI shell over
// that store, so these deep imports are the EXPLICIT, intended coupling — pin the
// boundary here so extraction drift is visible.

describe("task command plugin standalone boundary", () => {
  test("task shells the core/tasks store (+ worklog company-scope) over the SDK", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "task",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [
        /^(?:\.\.\/){3}core\/tasks\//,
        /^(?:\.\.\/){3}core\/worklog\/company-scope$/,
        /^(?:\.\.\/){3}commands\/shared\/comm-send$/, // actor resolution (same as maw hey)
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  // kobo-216 — task resolves its company through the STRICT resolver: --company wins,
  // else a multi-company `me` throws "ambiguous … specify --company" (option-a).
  test("company resolution uses companyOfOracleStrict (kobo-216 option-a)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    expect(src).toContain("companyOfOracleStrict");
  });

  test("CLI dispatches the documented subcommands", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    for (const sub of ['subcmd === "add"', 'subcmd === "ls"', 'subcmd === "start"', 'subcmd === "move"', 'subcmd === "claim"', 'subcmd === "assign"', 'subcmd === "ask"', 'subcmd === "mentions"', 'subcmd === "comment"', 'subcmd === "comments"', 'subcmd === "resolve"', 'subcmd === "migrate-comments"', 'subcmd === "review"', 'subcmd === "hold"', 'subcmd === "approve"', 'subcmd === "pr"', 'subcmd === "done"', 'subcmd === "reject"', 'subcmd === "note"', 'subcmd === "edit"', 'subcmd === "epic"', 'subcmd === "dep"', 'subcmd === "decompose"', 'subcmd === "archive"', 'subcmd === "block"', 'subcmd === "unblock"']) {
      expect(src).toContain(sub);
    }
    expect(src).toContain("setTaskDep"); // kobo-134: dep add/rm — edit parentIds post-create
    expect(src).toContain("decomposeEpic"); // kobo-146 C7: materialize a plan → child cards + links (option B)
    expect(src).toContain('"--plan"'); // decompose: the plan rides --plan as a JSON array
    expect(src).toContain("askTask"); // kobo-126: substantive question → parent-linked subcard (one shot)
    expect(src).toContain("pendingMentions"); // kobo-126: the @mention decision queue (read-only)
    expect(src).toContain("badFlagValue"); // kobo-126: reject flag-shaped ref values (pgw-35 epic:"--add" root cause)
    expect(src).toContain("setTaskEpic"); // kobo-72: set/clear containment parent post-create
    expect(src).toContain('"--kind"'); // kobo-72: add --kind epic|task
    expect(src).toContain("moveTask"); // kobo-70: re-file backlog ⇄ todo parking states
    expect(src).toContain('"--state"'); // kobo-70: add --state backlog|todo
    expect(src).toContain('"ready": "READY"'); // kobo-133: READY lane (deps cleared, auto-promoted)
    expect(src).toContain('state !== "ready"'); // kobo-133: move accepts ready (human override)
    expect(src).toContain('"approve": "APPROVE"'); // kobo-189: APPROVE lane label (human gate before done)
    expect(src).toContain('state !== "approve"'); // kobo-189: move accepts approve (human-gate override, parallel to ready)
    expect(src).toContain("addTask");
    expect(src).toContain("noteTask"); // kobo-39: append-only note — the only non-terminal verb (mid-flight truth)
    expect(src).toContain("editTask"); // kobo-213: reword title/body in place (same id, audit-noted)
    expect(src).toContain('reviewer: flags["--reviewer"]'); // kobo-214: edit amends the reviewer in place too (extends editTask, same audit)
    expect(src).toContain("notifyTaskComment"); // kobo-46: a note by a non-author pokes the assignee (comment = poke) on task-events
    expect(src).toContain("notifyCommentReply"); // kobo-156: a reply also pokes the parent comment's author (thread reaches the person answered)
    expect(src).toContain("commentTask"); // kobo-140: threaded ask/answer comment (the ask channel — thread/resolve/@mention)
    expect(src).toContain("resolveComment"); // kobo-140: resolve a comment thread → drops it from the mentions queue
    expect(src).toContain("migrateQuestionNotesToComments"); // kobo-142: one-shot copy question-notes → comments (active cards, idempotent)
    expect(src).toContain("startTask"); // eq3-007: assignee picks up own work (todo → in-progress)
    expect(src).toContain("claimTask");
    expect(src).toContain("assignTask"); // set assignee
    expect(src).toContain('"--force-reassign": Boolean'); // kobo-219: reassign is friction (correction only)
    expect(src).toContain('force: Boolean(flags["--force-reassign"])'); // flag → assignTask opts
    expect(src).toContain("isStaleDecisionCard"); // mawjs-5: soft stuck-decision badge (derived, visual only)
    expect(src).toContain("lastActivityByOracle"); // mawjs-5: owner-silence source for the badge
    expect(src).toContain("reviewTask");
    // kobo-144: reviewer system — per-card reviewer field + resolve chain + brake.
    expect(src).toContain("holdTask"); // hold verb: reviewer's brake, any state → review
    expect(src).toContain("approveTask"); // kobo-191: reviewer routes big-work review → approve (reason mandatory, Tony's queue)
    expect(src).toContain("resolveReviewer"); // chain: reviewer field → creator → human
    expect(src).toContain("notifyReviewer"); // review-lane → poke the resolved reviewer
    expect(src).toContain('"--reviewer"'); // add accepts a persistent per-card reviewer
    expect(src).toContain("setTaskPr"); // eq3-013: worker links the PR → card.pr + review
    expect(src).toContain("parsePrRepo"); // kobo-80: stamp card.repo from the PR url on pr-link
    expect(src).toContain("currentRepoSlug"); // kobo-80: fall back to the CWD git remote when only a number is given
    expect(src).toContain("repo derived from CWD"); // kobo-195: WARN on the CWD fallback — silent stamp of the wrong repo was the kobo-188 foot-gun
    expect(src).toContain("(use owner/name"); // kobo-99: reject a bare repo at link → never bind an unpollable repo
    expect(src).toContain("completeTask");
    expect(src).toContain("rejectTask"); // kobo-101: terminal "done but not accepted"
    expect(src).toContain("--reason is required"); // kobo-101: reason is mandatory on reject
    expect(src).toContain("archiveOldDone"); // eq3-008 P3: sweep old done → tasks/archive/
    expect(src).toContain("archiveTask"); // kobo-35: per-card archive by id (human "checked" a done card)
    expect(src).toContain("isOnBoard"); // board hides done outside the window
    expect(src).toContain("dependencyBlock"); // eq3-009a: derived blocked-by-dependency at board read
    expect(src).toContain("needsOwner"); // eq3-011 kobo-14: todo+unassigned → Blocked lane
    expect(src).toContain("parentStateResolver");
    expect(src).toContain('"--parent"'); // add accepts parent deps
    expect(src).toContain("checklistProgress"); // eq3-009c: body checklist N/M on the board
    expect(src).toContain('"--body"'); // add accepts a body
    expect(src).toContain("blockTask"); // eq3-009b: explicit block/unblock + kinds + for
    expect(src).toContain("unblockTask");
    expect(src).toContain("BLOCK_KINDS");
    // actor resolution matches `maw hey` (resolveSenderIdentity), not config.oracle
    expect(src).toContain("resolveSenderIdentity");
    // kobo-36 (eq3-036): task-event pings are tagged with the coord channel so a
    // multi-pane warroom routes them to the target's declared coord pane, not .0.
    expect(src).toContain('"--channel", "task-events"');
  });

  // cli-reorg kobo-26: `maw task` is HARD-REMOVED (no shim). The plugin exports
  // the shared `runTask` runner (imported by the company plugin for
  // `maw company task`) but registers NO cli command and NO default handler.
  test("exports runTask but has no shim handler / no default export", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    expect(src).toContain("export async function runTask");
    expect(src).not.toContain("export default"); // no top-level command handler
    expect(src).not.toContain("moved →"); // no deprecation shim notice
  });

  // Assert the AUTHORITATIVE manifest via loadManifestFromDir (reads plugin.ts
  // first, plugin.json fallback) — NOT a raw plugin.json read, so plugin.ts/json
  // drift can't hide a still-registered `maw task` command (kobo-26 regression).
  test("loaded manifest is a module surface with NO cli command (maw task → unknown)", () => {
    const manifest = loadManifestFromDir(join(import.meta.dir, "../../src/vendor/mpr-plugins/task"))!.manifest;
    expect(manifest.name).toBe("task");
    expect(manifest.cli).toBeUndefined(); // hard-removed — not dispatchable as `maw task`
    expect(manifest.module?.exports).toContain("runTask"); // company imports this
  });
});
