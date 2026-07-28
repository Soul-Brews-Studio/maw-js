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
    // kobo-405: ping()'s inline Bun.spawn(["maw","hey",...]) now routes through the
    // shared fail-closed-under-test seam (core/tasks/hey-spawn) — already covered by
    // the broad core/tasks/ allowRelative pattern above, pinned explicitly here so
    // the plugin-coverage-gate's "did this PR touch the companion test" check has a
    // real, reviewable signal instead of an incidental file touch.
    expect(imports).toContain("../../../core/tasks/hey-spawn");
  });

  // kobo-216 — task resolves its company through the STRICT resolver: --company wins,
  // else a multi-company `me` throws "ambiguous … specify --company" (option-a).
  test("company resolution uses companyOfOracleStrict (kobo-216 option-a)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    expect(src).toContain("companyOfOracleStrict");
    // kobo-341: cross-company dispatch guard — assign/add/review/edit/ask refuse a target
    // fully outside the card's company (the kobo-334 latent path).
    expect(src).toContain("companyScopeViolation");
  });

  test("CLI dispatches the documented subcommands", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    for (const sub of ['subcmd === "add"', 'subcmd === "ls"', 'subcmd === "next-ready"', 'subcmd === "start"', 'subcmd === "move"', 'subcmd === "claim"', 'subcmd === "assign"', 'subcmd === "ask"', 'subcmd === "mentions"', 'subcmd === "comment"', 'subcmd === "comments"', 'subcmd === "migrate-comments"', 'subcmd === "migrate-lanes"', 'subcmd === "review"', 'subcmd === "hold"', 'subcmd === "approve"', 'subcmd === "need-answer"', 'subcmd === "pr"', 'subcmd === "done"', 'subcmd === "deployed"', 'subcmd === "reject"', 'subcmd === "note"', 'subcmd === "edit"', 'subcmd === "epic"', 'subcmd === "dep"', 'subcmd === "decompose"', 'subcmd === "archive"', 'subcmd === "block"', 'subcmd === "unblock"', 'subcmd === "sign"', 'subcmd === "merge"']) {
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
    expect(src).toContain('"need-answer": "NEED-ANSWER"'); // kobo-218: NEED-ANSWER lane label (Tony's decision queue)
    expect(src).toContain('state !== "need-answer"'); // kobo-218: move accepts need-answer (Tony decision queue, reason mandatory)
    expect(src).toContain('"wait-for-deploy": "WAIT-DEPLOY"'); // kobo-273: WAIT-DEPLOY lane label (merged≠live park)
    expect(src).toContain('state !== "wait-for-deploy"'); // kobo-273: move accepts wait-for-deploy (manual park target, no reason)
    expect(src).toContain("needAnswerTask"); // kobo-218: owner parks a card in Tony's decision queue (reason mandatory)
    expect(src).toContain('addState !== "approve"'); // kobo-218: add accepts --state approve (CREATE a deploy-approval card into the lane)
    expect(src).toContain('addState === "approve"'); // kobo-218: born-in-approve requires --reason (Approve lane invariant)
    expect(src).toContain("approvalTemplate"); // kobo-222: prefill the 9-section template on a body-less approve-card
    expect(src).toContain("missingApprovalSections"); // kobo-222: soft-warn which required sections a supplied body skips
    expect(src).toContain("addTask");
    expect(src).toContain("noteTask"); // kobo-39: append-only note — the only non-terminal verb (mid-flight truth)
    expect(src).toContain("editTask"); // kobo-213: reword title/body in place (same id, audit-noted)
    expect(src).toContain('reviewer: flags["--reviewer"]'); // kobo-214: edit amends the reviewer in place too (extends editTask, same audit)
    expect(src).toContain('"--deploy-required": Boolean'); // kobo-274: add/edit override the merge-park default
    expect(src).toContain('"--no-deploy-required": Boolean');
    expect(src).toContain("deployRequired"); // kobo-274: forwarded into addTask/editTask (has-PR default → wait-for-deploy)
    expect(src).toContain("notifyTaskComment"); // kobo-46: a note by a non-author pokes the assignee (comment = poke) on task-events
    // kobo-406: notifyTaskComment now takes a required kind ("note"|"comment") so the
    // notification verb matches what was actually written — pin both call sites explicit.
    expect(src).toContain('notifyTaskComment(t, me, noteText, "note")'); // note verb
    expect(src).toContain('notifyTaskComment(t, me, text, "comment")'); // comment verb
    expect(src).toContain("notifyCommentReply"); // kobo-156: a reply also pokes the parent comment's author (thread reaches the person answered)
    expect(src).toContain("commentTask"); // kobo-140: threaded ask/answer comment (the ask channel — thread/@mention)
    expect(src).toContain("commentClarityError"); // kobo-263: @tony/@human comment → tldr+ask REQUIRED (tool rejects; supersedes the 262 nudge)
    expect(src).not.toContain("commentClarityNudge"); // kobo-263: the interim S1 nudge is removed
    expect(src).not.toContain("resolveComment"); // kobo-237: resolve concept removed
    expect(src).not.toContain('subcmd === "resolve"'); // kobo-237: resolve subcommand gone
    expect(src).not.toContain("|resolve|"); // kobo-238 fold: usage string must not advertise the removed verb
    expect(src).toContain("migrateQuestionNotesToComments"); // kobo-142: one-shot copy question-notes → comments (active cards, idempotent)
    expect(src).toContain("reconcileTwoLaneCards"); // kobo-257: one-shot board-wide 2-lane reconcile migration (idempotent, non-destructive)
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
    expect(src).toContain('"--gate": Boolean'); // kobo-224: gated brake → approve lane (Tony's queue), replace hold+@tony
    expect(src).toContain("holdTask(company, id, me, flags[\"--reason\"], { gate })"); // flag → holdTask opts
    expect(src).toContain("approveTask"); // kobo-191: reviewer routes big-work review → approve (reason mandatory, Tony's queue)
    expect(src).toContain("resolveReviewer"); // chain: reviewer field → creator → human
    expect(src).toContain("notifyReviewer"); // review-lane → poke the resolved reviewer
    // kobo-328: reviewer-routing — REFUSE a self-review dispatch (executor≠reviewer).
    expect(src).toContain("isSelfReview"); // dispatch guard: --to === assignee is barred
    expect(src).toContain("self-review banned"); // loud refuse, not a silent downgrade
    expect(src).toContain("no independent reviewer"); // visibility when the chain falls to human
    expect(src).toContain('"--reviewer"'); // add accepts a persistent per-card reviewer
    // kobo-327: merge-gate — the 2-sign anti-race funnel enforced in software.
    expect(src).toContain("signTask"); // sign verb: record a crew/head gate sign (idempotent, who+ts)
    expect(src).toContain("missingSignTiers"); // merge refuses until every required tier is signed
    expect(src).toContain("requiredSignTiers"); // head always; +crew iff crewGate (non-crew card = single-tier)
    expect(src).toContain('"--crew-gate": Boolean'); // add pre-declares a crew-cell card (closes head-before-crew race)
    expect(src).toContain('"--role": String'); // sign --role crew|head
    expect(src).toContain('"--method": String'); // merge --method merge|squash|rebase
    expect(src).toContain("gh pr merge failed"); // merge shells to gh only after the gate passes
    // kobo-331: FAIL-CLOSED — unset crewGate refuses instead of merging head-only.
    expect(src).toContain('"--single-tier": Boolean'); // explicit no-crew escape flag
    expect(src).toContain("crewGate is not set"); // fail-closed refuse message
    expect(src).toContain("process.env.CREW_ROLE"); // kobo-333: crew-dispatch stamp (claim/start in crew pane → crewGate=true)
    // kobo-546: diff-aware tier classification — stamped at PR-open (`pr` verb) and
    // re-checked at merge-time (merge-time wins over a stale stamp, same rebase shape
    // kobo-544 closed for sha). --single-tier usage is logged (who/when/card) via the
    // card's own notes, never silent.
    expect(src).toContain("reclassifyAndEscalate");
    expect(src).toContain("fetchPrDiffFiles");
    expect(src).toContain("--single-tier used for merge");
    // kobo-546 REWORK: no MAW_TEST_MODE branch anywhere on the gate path — a code
    // branch in the gate is the hole, not a missing env-discipline rule. Injectable
    // seam instead: real fetcher by default, test-only override + reset.
    expect(src).not.toContain('process.env.MAW_TEST_MODE !== "1" && t.pr');
    expect(src).toContain("__setPrDiffFetcherForTest");
    expect(src).toContain("__resetPrDiffFetcherForTest");
    expect(src).toContain("crew-gated"); // --single-tier rejected on a crew-gated card
    // kobo-336: a crew card needs two INDEPENDENT signers — one oracle can't fill both tiers.
    expect(src).toContain("sameSignerBothTiers"); // merge backstop: refuse same-signer crew+head
    expect(src).toContain("already signed the"); // sign-time early refuse of the second tier
    expect(src).toContain("signed BOTH the crew and head tier"); // merge refuse message
    // kobo-346: bind sign to the signing PANE — reviewer-role + distinct-pane, defense-in-depth.
    expect(src).toContain("resolveSignerPane"); // live tmux pane-id at sign-time (Option B)
    expect(src).toContain("signPaneViolation"); // item-4 reviewer-role + item-3 distinct-pane guard
    expect(src).toContain("samePaneBothTiers"); // merge pane-distinct backstop
    // kobo-400: bind a sign to the commit it reviewed (epic-326's last hole — a sign only
    // proved WHEN, not WHAT). Capture at sign-time, enforce at merge-time via gh's own
    // atomic --match-head-commit (no compare-then-act race in our own code).
    expect(src).toContain('"--json", "headRefOid"'); // sign-time SHA capture (best-effort, never blocks the sign itself)
    expect(src).toContain("signedSha"); // captured SHA passed into signTask
    expect(src).toContain("crewSignedSha"); // task field: crew tier's reviewed commit
    expect(src).toContain("headSignedSha"); // task field: head tier's reviewed commit
    expect(src).toContain("--match-head-commit"); // GitHub enforces atomically server-side at merge
    expect(src).toContain("different commits, only one tier actually reviewed"); // crew≠head refuse — the hole convergent-discovered from two angles (kobo-336's own distinct-signer rule opened this window)
    expect(src).toContain("pre-signSha-bind sign"); // legacy grandfather warning (field-absence trigger, no flag-day — kobo-404 tightens later)
    // kobo-557: SHA-compare at merge-time only proves crew+head agree with EACH OTHER,
    // never that either read what they signed — --sha makes the signer's read explicit
    // and REFUSES (not warns) when the head has moved since. Injectable fetcher (no
    // MAW_TEST_MODE branch in the gate path — kobo-546's lesson).
    expect(src).toContain('"--sha": String');
    expect(src).toContain("__setHeadShaFetcherForTest");
    expect(src).toContain("__resetHeadShaFetcherForTest");
    expect(src).toContain("someone pushed since you read it");
    // kobo-557 — Tony's ruling (path 2): (A) no PR linked is a workflow gap → REFUSE
    // (stamp it, fixable in 5 seconds). (C) a gh fetch failure with the PR linked is
    // the network-dependency shape kobo-404 protects → ALLOW through, loud — the
    // output line must say plainly no SHA bound, distinct from a genuine bind.
    expect(src).toContain("no PR linked yet");
    expect(src).toContain("NO SHA BOUND");
    // kobo-501: a sign records WHAT justified it (diff-read vs a real test-run vs
    // mutation-verified), not just sha+pane — undeclared is the true default, never
    // silently upgraded to diff-read (the collapse-unknown-into-a-value defect class).
    expect(src).toContain('"--evidence": String');
    expect(src).toContain('"--evidence-locus": String');
    expect(src).toContain('?? "undeclared"'); // omitted --evidence records the honest unknown
    expect(src).toContain("evidenceScopeViolation"); // sign-time refuse: test-run+ claims require a locus
    expect(src).toContain("--evidence must be one of"); // unrecognized --evidence value is refused, not swallowed
    expect(src).toContain("formatSignEvidenceScope"); // distinguishable label in the sign confirmation line
    expect(src).toContain("sameEvidenceLocusBothTiers"); // merge backstop: both tiers citing the same evidence
    expect(src).toContain("same evidence locus"); // merge refuse message (real kobo-482 shape)
    expect(src).toContain("setTaskPr"); // eq3-013: worker links the PR → card.pr + review
    // kobo-507: clear a stale/superseded pr link — the manual way out setTaskPr's
    // number-only signature couldn't provide (the real kobo-495 shape).
    expect(src).toContain("clearTaskPr");
    expect(src).toContain('"--clear": Boolean');
    expect(src).toContain("--reason is required to clear a PR link");
    expect(src).toContain("no PR number with --clear"); // mutually exclusive with a positional PR number
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
    expect(src).toContain("dependencyBlock"); // eq3-009a: derived detail (WHICH parents) for the label content
    expect(src).toContain('t.state === "blocked" || needsOwner(t)'); // kobo-255: off-flow reads the REAL state (slice-A makes dep-pending state="blocked") — no derived overlay-on-other-state; terminal-gate (kobo-246) subsumed since blocked ≠ terminal
    expect(src).toContain("needsOwner"); // eq3-011 kobo-14: todo+unassigned → Blocked lane
    // kobo-356: next-ready — crew idle-dispatch queue query, reuses needsOwner (no new derive)
    expect(src).toContain("NEXT-READY"); // a ready unassigned card found
    expect(src).toContain("NO-READY-WORK inFlight="); // queue empty; inFlight = still in-progress/review
    // kobo-365: deterministic tie-break — a ts-only comparator ties same-millisecond
    // cards (a real CI flake) and falls back on non-guaranteed readdir order; id
    // (a monotonic per-company counter) is the secondary key.
    expect(src).toContain("compareReadyOrder");
    expect(src).toContain("sort(compareReadyOrder)");
    expect(src).toContain("parentStateResolver");
    expect(src).toContain('"--parent"'); // add accepts parent deps
    expect(src).toContain("checklistProgress"); // eq3-009c: body checklist N/M on the board
    expect(src).toContain('"--body"'); // add accepts a body
    expect(src).toContain("blockTask"); // eq3-009b: explicit block/unblock + kinds + for
    expect(src).toContain("unblockTask");
    expect(src).toContain("BLOCK_KINDS");
    // kobo-335: actor resolution AUTHENTICATES the --from claim against the agent self
    // (authenticateActor: CLAUDE_AGENT_NAME/tmux; a claim for another oracle is refused),
    // not the old trust-any resolveSenderIdentity.
    expect(src).toContain("authenticateActor");
    // kobo-36 (eq3-036): task-event pings are tagged with the coord channel so a
    // multi-pane warroom routes them to the target's declared coord pane, not .0.
    expect(src).toContain('"--channel", "task-events"');
    // kobo-335: the engine-level ping honors MAW_TEST_MODE (like notify.ts) so a test
    // driving a verb with a real oracle target can't spawn a real `maw hey` into a live
    // pane — the isolation hole that leaked fixture events onto the board.
    expect(src).toContain('process.env.MAW_TEST_MODE === "1") return');
  });

  // kobo-394 — echo-truth: start/claim/hold go through writeTaskWithDepGuard, which
  // can clobber the intended write to blocked when a dependency is still pending.
  // Pin that the CLI echo reads the REAL post-reconcile state (taskNextAction, which
  // already handles the blocked case + reason) instead of a hardcoded "(in-progress)"/
  // "review" label — that hardcoding was the actual echo-lie bug (behavioral proof in
  // plugin-task-cli.test.ts; this pins the source shape so it can't silently regress).
  test("start/claim/hold echo taskNextAction(t), never a hardcoded state label (kobo-394)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    const startLine = src.split("\n").find((l) => l.includes("▶ started"));
    const claimLine = src.split("\n").find((l) => l.includes("⛏ claimed"));
    expect(startLine).toContain("taskNextAction(t)");
    expect(claimLine).toContain("taskNextAction(t)");
    expect(startLine).not.toContain("(in-progress)"); // the old hardcoded lie
    expect(claimLine).not.toContain("(in-progress)");
    expect(src).toContain('t.state === "blocked"'); // hold's non-gate branch checks real state before echoing
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

  // kobo-368 compact-ack sweep: `ls` defaults to a lane-count summary; `--full`/
  // `--verbose` reproduce the pre-368 per-card renderBoard byte-for-byte.
  test("ls: default compact (renderBoardCompact) vs --full/--verbose (renderBoard) gate", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    expect(src).toContain("function renderBoardCompact");
    const lsStart = src.indexOf('subcmd === "ls"');
    const nextReadyStart = src.indexOf('subcmd === "next-ready"');
    const lsBlock = src.slice(lsStart, nextReadyStart);
    expect(lsBlock).toContain('args.includes("--full")');
    expect(lsBlock).toContain('args.includes("--verbose")');
    expect(lsBlock).toContain("renderBoard(tasks"); // --full path
    expect(lsBlock).toContain("renderBoardCompact(tasks"); // default path
  });

  // kobo-569 — need-answer (kobo-218) was missing from BOTH renderBoard's per-lane
  // loop and renderBoardCompact's laneOrder; a card parked there never rendered.
  // Behavioral coverage (real board output) lives in plugin-task-cli.test.ts; this
  // is the content-assert companion this standalone file's own convention expects.
  test("renderBoard has a dedicated need-answer branch, renderBoardCompact's laneOrder carries it (kobo-569)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    const boardStart = src.indexOf("function renderBoard(");
    const compactStart = src.indexOf("function renderBoardCompact(");
    const boardBlock = src.slice(boardStart, compactStart);
    expect(boardBlock).toContain('t.state === "need-answer"');
    const compactBlock = src.slice(compactStart);
    expect(compactBlock).toContain('"need-answer"');
    const laneOrderLine = compactBlock.split("\n").find((l) => l.includes("laneOrder"))!;
    expect(laneOrderLine).toContain("TASK_FLOW");
    expect(laneOrderLine).toContain('"need-answer"');
  });

  // kobo-570 — no-silent-caps: isOnBoard() (ADR 0002 P3) hides done/rejected cards
  // older than the archive window before either render function sees the list.
  // Both renderBoard and renderBoardCompact must say how many they hid, scoped to
  // whatever the view (--mine) is already scoped to — not the whole board's count
  // slapped on a filtered view (review round 1 finding, fixed in this same PR).
  // Behavioral coverage lives in plugin-task-cli.test.ts; this is the content-assert
  // companion this standalone file's own convention expects.
  test("ls computes the hidden-count AFTER --mine scoping, both render fns take it (kobo-570)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    expect(src).toContain("function hiddenSummaryLine");
    const lsStart = src.indexOf('subcmd === "ls"');
    const nextReadyStart = src.indexOf('subcmd === "next-ready"');
    const lsBlock = src.slice(lsStart, nextReadyStart);
    // `mine` filters allTasks BEFORE hiddenDone/hiddenRejected are derived from it —
    // the ordering that keeps the count scoped to the view (kobo-570 review round 1).
    const mineFilterIdx = lsBlock.indexOf("if (mine) allTasks = allTasks.filter");
    const hiddenDoneIdx = lsBlock.indexOf("const hiddenDone =");
    expect(mineFilterIdx).toBeGreaterThan(-1);
    expect(mineFilterIdx).toBeLessThan(hiddenDoneIdx);
    expect(lsBlock).toContain("renderBoard(tasks, company, mine, stale, hiddenDone, hiddenRejected)");
    expect(lsBlock).toContain("renderBoardCompact(tasks, company, mine, hiddenDone, hiddenRejected)");
  });

  // kobo-580 — pendingMentions() stopped gating on isOnBoard (rule 10: a comment
  // doesn't close because its card is done), so the raw count can be much bigger
  // than what used to show (measured live: kobo 20→116, pgw 19→294). The CLI
  // header must break out how many came from a card already off the board, so a
  // big number reads as "mostly old chatter" rather than "healthy queue".
  // Behavioral coverage lives in plugin-task-cli.test.ts; this is the
  // content-assert companion this standalone file's own convention expects.
  test("mentions header computes and prints the aged-off share of the count (kobo-580)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    const mentionsStart = src.indexOf('subcmd === "mentions"');
    const nextBlockStart = src.indexOf('subcmd === "comment"');
    const mentionsBlock = src.slice(mentionsStart, nextBlockStart);
    expect(mentionsBlock).toContain("pendingMentions(company, flags[\"--for\"])");
    // aged = pending items whose OWN card fails isOnBoard — not the queue itself
    // (pendingMentions still returns everything, unfiltered, per kobo-580).
    const agedIdx = mentionsBlock.indexOf("const aged =");
    expect(agedIdx).toBeGreaterThan(-1);
    expect(mentionsBlock.slice(agedIdx)).toContain("!isOnBoard(t)");
    expect(mentionsBlock).toContain("agedNote");
    expect(mentionsBlock).toContain("DEFAULT_ARCHIVE_DAYS");
  });
});
