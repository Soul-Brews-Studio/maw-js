/**
 * maw company task — company task board CLI (ADR 0001 backbone; cli-reorg ADR
 * docs/company/0001). Agents use the maw_task MCP tool; the top-level `maw task`
 * is a deprecation shim (one release) that forwards to the shared runner.
 *
 *   maw company task add "<title>" [--repo r] [--dept d] [--epic e] [--assignee a] [--parent id,...] [--body "...md..."]
 *   maw company task ls [--company c] [--mine] [--for <who>]  # BLOCKED group · ☑ N/M checklist · --for = decision queue
 *   maw company task start <id>
 *   maw company task claim <id>
 *   maw company task assign <id> --to <who>  # pass the ball — set assignee=<who> (e.g. human) without taking it; by stays the real actor (mawjs-5)
 *   maw company task ask <parentId> "<question>" [--to who]  # substantive question → subcard assigned to answerer (default tony) + parent-linked, one shot (kobo-126)
 *   maw company task mentions [--for who]    # unanswered @tony/@human mentions across the board — the decision queue (kobo-126)
 *   maw company task pr <id> <pr-number>   # worker links the PR → card.pr + review (pr-watch drives merge→done)
 *   maw company task done <id>             # also clears an explicit block
 *   maw company task note <id> "<text>"    # append-only note — mid-flight truth (kobo-39)
 *   maw company task archive <id>          # per-card: human reviewed this done card → tasks/archive/ (kobo-35)
 *   maw company task archive [--days N]    # bulk: sweep done cards older than N days → tasks/archive/
 *   maw company task block <id> --kind <dependency|needs_input|capability|transient> [--reason "..."] [--for tony|<oracle>|any]
 *   maw company task unblock <id>          # restore prevState
 *   maw company task dep add <id> <parentId>  # link a dependency after create — <id> waits for <parentId> (kobo-134)
 *   maw company task dep rm <id> <parentId>   # remove a dependency link
 *
 * State lives in the file-per-card store (companies/<c>/tasks/*.json); every
 * mutation also emits a worklog event so the activity feed stays the single
 * timeline. claim = set assignee + in-progress (ADR §1). create/assign is open
 * to anyone (transparency, not permission): `by` records the delegator and the
 * assignee is pinged on assignment (ADR §5).
 */

import { parseFlags } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { companyOfOracleStrict } from "../../../core/worklog/company-scope";
import {
  addTask,
  archiveOldDone,
  archiveTask,
  askTask,
  assignTask,
  BLOCK_KINDS,
  blockNextAction,
  blockTask,
  checklistProgress,
  approvalTemplate,
  missingApprovalSections,
  claimTask,
  commentClarityError,
  commentTask,
  completeTask,
  decomposeEpic,
  DEFAULT_ARCHIVE_DAYS,
  dependencyBlock,
  holdTask,
  isOnBoard,
  isStaleDecisionCard,
  lastActivityByOracle,
  listTasks,
  needsOwner,
  noteTask,
  pendingMentions,
  parentStateResolver,
  parseMentions,
  parsePrNumber,
  approveTask,
  needAnswerTask,
  migrateQuestionNotesToComments,
  reconcileTwoLaneCards,
  parsePrRepo,
  readTask,
  rejectTask,
  resolveReviewer,
  reviewTask,
  setTaskDep,
  setTaskEpic,
  setTaskPr,
  moveTask,
editTask,
  startTask,
  taskNextAction,
  TASK_FLOW,
  unblockTask,
  type BlockKind,
  type DecomposeChild,
  type DependencyBlock,
  type TaskKind,
  type TaskRecord,
  type TaskState,
} from "../../../core/tasks/store";
import { notifyCommentReply, notifyReviewer, notifyTaskComment } from "../../../core/tasks/notify";

/**
 * Best-effort `owner/repo` of the git repo at CWD (kobo-80). The worker links a PR
 * from inside its worktree, so the origin remote names the repo the PR lives in —
 * used to stamp card.repo when `task pr` gets a bare number (no url to parse from).
 * Never throws: outside a repo / no origin → undefined, and the caller just skips.
 */
function currentRepoSlug(): string | undefined {
  try {
    const p = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return undefined;
    const url = p.stdout.toString().trim();
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(url);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Resolve the acting oracle the SAME way `maw hey` does (resolveSenderIdentity),
 * so the board shows the real name (eq3 / patchwork) — the old config.oracle-first
 * resolver returned the bare node default "mawjs". A raw CLI with no agent
 * identity (no --from / MAW_SENDER / CLAUDE_AGENT_NAME / tmux) is a person →
 * label "human", not the node default. Dynamic import keeps comm-send out of the
 * plugin's static link graph (widely-mocked module).
 */
async function resolveActor(from?: string): Promise<string> {
  try {
    const { resolveSenderIdentity } = await import("../../../commands/shared/comm-send");
    const id = resolveSenderIdentity(loadConfig(), from ? { from } : {});
    if (id.source !== "auto") return id.senderName; // explicit --from / MAW_SENDER
    if (process.env.CLAUDE_AGENT_NAME || process.env.TMUX) return id.senderName; // real agent / pane
    return "human"; // bare node default — a person at the CLI, not an oracle
  } catch {
    return process.env.CLAUDE_AGENT_NAME || "human";
  }
}

function resolveCompany(flag: string | undefined, me: string): string | null {
  // kobo-216 — strict: --company wins; else a multi-company `me` THROWS "ambiguous …
  // specify --company" instead of silently first-matching. Single-company + config
  // fallback are unchanged.
  return companyOfOracleStrict(me, flag) ?? ((loadConfig() as Record<string, unknown>).company as string) ?? null;
}

/**
 * kobo-126 — arg(permissive) binds the NEXT token to a string flag even when that
 * token is itself a flag: `--epic --add` silently sets epic="--add" (the real
 * corruption on pgw-35). A card id / oracle / repo never starts with "-", so a
 * flag-shaped value means the user dropped the real value — reject it instead of
 * persisting garbage. Returns an error string (caller returns it) or null if ok.
 */
function badFlagValue(label: string, value: string | undefined): string | null {
  if (typeof value === "string" && value.startsWith("-")) {
    return `missing value for ${label} (got "${value}" — looks like another flag)`;
  }
  return null;
}

/**
 * Best-effort ping (assignee/reviewer notified on task events) — never blocks
 * the CLI. kobo-36 (eq3-036): tagged with `--channel task-events` so, in a
 * multi-pane warroom, the notification lands in the target's coordinator pane
 * (if it declared one via `maw route set task-events .N`) instead of the default
 * main pane. No mapping registered → `maw hey` keeps its default-pane behavior.
 */
function ping(target: string, message: string): void {
  try {
    // ponytail: channel is hard-coded "task-events" — all task board pings are
    // coord-plane events; a per-event channel split isn't needed yet.
    Bun.spawn(["maw", "hey", "--channel", "task-events", target, message], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* worklog already recorded the event — delivery is best effort */
  }
}

const STATE_LABEL: Record<TaskState, string> = {
  "backlog": "BACKLOG",
  "todo": "TODO",
  "ready": "READY",
  "in-progress": "IN-PROGRESS",
  "review": "REVIEW",
  "need-answer": "NEED-ANSWER",
  "approve": "APPROVE",
  "wait-for-deploy": "WAIT-DEPLOY",
  "done": "DONE",
  "rejected": "REJECTED",
  "blocked": "BLOCKED",
};

function cardHead(t: TaskRecord): string {
  const who = t.assignee ? `\x1b[32m@${t.assignee}\x1b[0m` : "\x1b[90m(unassigned)\x1b[0m";
  const pr = t.pr ? ` \x1b[33mPR#${t.pr}\x1b[0m` : "";
  // checklist progress N/M (ADR 0003 C) — only when the body has checkboxes
  const cl = checklistProgress(t.body);
  const prog = cl ? ` \x1b[35m☑ ${cl.done}/${cl.total}\x1b[0m` : "";
  return `  \x1b[90m${t.id}\x1b[0m ${t.title} ${who}${pr}${prog}`;
}

/** Faint warning line for parent ids that resolve to nothing (ADR 0003 A). */
function missingLine(info: DependencyBlock): string | null {
  return info.missing.length ? `    \x1b[90m⚠ parent ไม่พบ: ${info.missing.join(", ")}\x1b[0m` : null;
}

function renderBoard(tasks: TaskRecord[], company: string, mine: string | null, stale: Set<string> = new Set()): string {
  const lines: string[] = [];
  lines.push(`\x1b[36m▌ ${company} board\x1b[0m${mine ? ` \x1b[90m(--mine ${mine})\x1b[0m` : ""}`);
  if (!tasks.length) { lines.push("  \x1b[90m(no tasks)\x1b[0m"); return lines.join("\n"); }

  // Off-flow = explicit-or-dependency block (state="blocked") OR derived needs-owner
  // (eq3-011 kobo-14, todo+unassigned). kobo-255/slice-A: a dep-pending card now IS
  // state="blocked" (state is the source of truth), so render reads state — no derived
  // overlay-on-other-state. `dep` is still computed for the WHICH-parents label content.
  const resolveParent = parentStateResolver(company);
  const dep = new Map(tasks.map((t) => [t.id, dependencyBlock(t, resolveParent)] as const));
  const offFlow = (t: TaskRecord) => t.state === "blocked" || needsOwner(t);
  const flow = tasks.filter((t) => !offFlow(t));
  const blocked = tasks.filter(offFlow);

  for (const state of TASK_FLOW) {
    const inState = flow.filter((t) => t.state === state);
    if (!inState.length) continue;
    lines.push(`\n\x1b[1m${STATE_LABEL[state]}\x1b[0m \x1b[90m(${inState.length})\x1b[0m`);
    for (const t of inState) {
      lines.push(cardHead(t));
      // next-action — the board always says what happens next + who (Track 4)
      lines.push(`    \x1b[90m↳\x1b[0m \x1b[36m${taskNextAction(t)}\x1b[0m`);
      // soft stuck-decision badge (mawjs-5) — visual only, no state change
      if (stale.has(t.id)) lines.push(`    \x1b[90m↳\x1b[0m \x1b[33m⏳ stuck? ball on?\x1b[0m`);
      const m = missingLine(dep.get(t.id)!); if (m) lines.push(m);
    }
  }

  // Rejected lane (kobo-101) — terminal "not accepted", parallel to DONE. Not in
  // TASK_FLOW (it's off the linear flow), so surface it in its own lane or the
  // flow loop above drops it silently.
  const rejected = flow.filter((t) => t.state === "rejected");
  if (rejected.length) {
    lines.push(`\n\x1b[1m\x1b[33m${STATE_LABEL.rejected}\x1b[0m \x1b[90m(${rejected.length})\x1b[0m`);
    for (const t of rejected) {
      lines.push(cardHead(t));
      lines.push(`    \x1b[90m↳\x1b[0m \x1b[33m${taskNextAction(t)}\x1b[0m`);
    }
  }

  if (blocked.length) {
    lines.push(`\n\x1b[1m\x1b[31mBLOCKED\x1b[0m \x1b[90m(${blocked.length})\x1b[0m`);
    for (const t of blocked) {
      lines.push(cardHead(t));
      if (t.state === "blocked") lines.push(`    \x1b[90m↳\x1b[0m \x1b[31m${blockNextAction(t)}\x1b[0m`); // explicit (kind/for/reason)
      const d = dep.get(t.id)!;
      if (d.blockedBy.length) lines.push(`    \x1b[90m↳\x1b[0m \x1b[31m🚫 รอ: ${d.blockedBy.join(", ")}\x1b[0m`); // derived deps
      if (needsOwner(t)) lines.push(`    \x1b[90m↳\x1b[0m \x1b[31m⚑ ยังไม่มีเจ้าของ — รอ assign\x1b[0m`); // derived needs-owner (kobo-14)
      const m = missingLine(d); if (m) lines.push(m);
    }
  }
  return lines.join("\n");
}

/**
 * Shared task-board CLI runner — the single source of truth for the task verbs.
 * Both `maw company task` (company plugin) and the top-level `maw task` shim call
 * this, so the two surfaces can never diverge (cli-reorg ADR docs/company/0001).
 * `emit` receives user-facing lines; returns an ok/error result.
 */
export async function runTask(
  args: string[],
  emit: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const origLog = console.log;
  console.log = (...a: unknown[]) => emit(a.map(String).join(" "));

  try {
    const subcmd = args[0];

    if (subcmd === "add") {
      const flags = parseFlags(args.slice(1), {
        "--repo": String, "--dept": String, "--epic": String, "--assignee": String, "--company": String, "--from": String, "--parent": [String], "--body": String, "--state": String, "--kind": String, "--reviewer": String, "--reason": String, "--deploy-required": Boolean, "--no-deploy-required": Boolean,
      }, 0);
      const me = await resolveActor(flags["--from"]);
      const title = flags._.join(" ").trim(); // positionals only — flag values excluded
      if (!title) return { ok: false, error: 'usage: maw company task add "<title>" [--kind epic|task --repo r --dept d --epic e --assignee a --parent id --body text --state backlog|todo|approve (approve → --reason required)]' };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c> (could not resolve from config)" };
      // --kind (kobo-72): mark a container card (epic). Default/absent = task.
      const addKind = flags["--kind"] as TaskKind | undefined;
      if (addKind && addKind !== "epic" && addKind !== "task") {
        return { ok: false, error: `--kind must be epic or task` };
      }
      // --state (kobo-70): manual add opens on todo; --state backlog parks it. Only
      // the two "not-yet-in-flow" states are addable here (in-progress/review/done
      // are reached via start/review/done). blocked has its own verb.
      // kobo-218: `approve` is ALSO addable — the deploy/critical Tony-gate CREATES its
      // own card straight into the Approve lane (distinct from need-answer, which MOVES
      // an existing work-card). The Approve lane invariant holds: a born-in-approve card
      // must carry --reason (why it needs Tony), same as approveTask/move-to-approve.
      const addState = flags["--state"] as TaskState | undefined;
      if (addState && addState !== "backlog" && addState !== "todo" && addState !== "approve") {
        return { ok: false, error: `--state must be backlog, todo or approve (in-progress/review/done via start/review/done; approve = create a deploy-approval card, --reason required)` };
      }
      if (addState === "approve" && (!flags["--reason"] || !flags["--reason"].trim())) {
        return { ok: false, error: "--reason is required to add a card into approve (the Approve lane is Tony's queue — say why it needs a deploy/critical decision)" };
      }
      // Reject flag-shaped ref values (kobo-126) before they persist as corrupt data.
      for (const [label, v] of [["--epic", flags["--epic"]], ["--assignee", flags["--assignee"]], ["--repo", flags["--repo"]], ["--dept", flags["--dept"]], ["--reviewer", flags["--reviewer"]]] as const) {
        const err = badFlagValue(label, v as string | undefined);
        if (err) return { ok: false, error: err };
      }
      // --parent repeatable AND comma-separated: --parent a,b --parent c → [a,b,c]
      const parentIds = (flags["--parent"] ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
      const badParent = parentIds.find((p) => p.startsWith("-"));
      if (badParent) return { ok: false, error: badFlagValue("--parent", badParent)! };
      // kobo-222: a born-in-approve card (deploy/money-path) carries the 9-section
      // template — PREFILL it when the creator gives no --body, so Tony gets the full
      // decision picture. A supplied body is kept as-is (warned below if it skips sections).
      const addBody = (addState === "approve" && !flags["--body"]?.trim()) ? approvalTemplate() : flags["--body"];
      // kobo-274: override the merge-park default (has-PR). --deploy-required → always
      // park, --no-deploy-required → always straight to done; neither → unset (default).
      if (flags["--deploy-required"] && flags["--no-deploy-required"]) {
        return { ok: false, error: "pass only one of --deploy-required / --no-deploy-required" };
      }
      const deployRequired = flags["--deploy-required"] ? true : (flags["--no-deploy-required"] ? false : undefined);
      const t = addTask({
        company, title, by: me, kind: addKind,
        dept: flags["--dept"], epic: flags["--epic"], repo: flags["--repo"], assignee: flags["--assignee"] ?? null,
        parentIds, body: addBody, state: addState, reviewer: flags["--reviewer"], deployRequired,
        reviewReason: addState === "approve" ? flags["--reason"]!.trim() : undefined, // kobo-218: Approve lane invariant — carry the WHY
      });
      console.log(`\x1b[32m✚ created\x1b[0m ${t.id} \x1b[90m(${t.state})\x1b[0m: ${t.title}`);
      // kobo-222: guide (not block) — an approve-card whose body skips required sections
      // gets a soft warn listing them, so the approver knows what's still missing.
      if (addState === "approve") {
        const missing = missingApprovalSections(t.body);
        if (!flags["--body"]?.trim()) {
          console.log(`  \x1b[36m↳ prefilled 9-section approval template — fill each section before Tony reviews\x1b[0m`);
        } else if (missing.length) {
          console.log(`  \x1b[33m⚠ approval-card missing ${missing.length}/9 section(s): ${missing.map((s) => `${s.n}.${s.head}`).join(", ")}\x1b[0m`);
        }
      }
      const addProg = checklistProgress(t.body);
      if (addProg) console.log(`  \x1b[35m↳ checklist: ${addProg.done}/${addProg.total}\x1b[0m`);
      if (t.parentIds?.length) {
        console.log(`  \x1b[90m↳ deps: ${t.parentIds.join(", ")}\x1b[0m`);
        // soft hint — a parent that resolves to nothing now will warn faintly on the board too
        const resolve = parentStateResolver(company);
        const unknown = t.parentIds.filter((p) => resolve(p) === null);
        if (unknown.length) console.log(`  \x1b[33m⚠ parent ไม่พบ (ยัง add ได้): ${unknown.join(", ")}\x1b[0m`);
      }
      if (t.assignee && t.assignee !== me) {
        ping(t.assignee, `[task] ${me} assigned you ${t.id}: ${t.title}`);
        console.log(`  \x1b[36m→ pinged ${t.assignee}\x1b[0m`);
      }
    } else if (subcmd === "ls") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--for": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const mine = args.includes("--mine") ? me : null;
      // Board shows done only within the window (ADR 0002 P3) — old done ages
      // off here even before the archive sweep physically moves it.
      let tasks = listTasks(company).filter((t) => isOnBoard(t));
      if (mine) tasks = tasks.filter((t) => t.assignee === mine);
      // --for <who> → the decision queue: blocked cards waiting on that person (ADR 0003 B)
      if (flags["--for"]) tasks = tasks.filter((t) => t.state === "blocked" && t.block?.for === flags["--for"]);
      // stuck-decision badge (mawjs-5 backstop) — DERIVED at read, never mutates state
      const activity = lastActivityByOracle(company);
      const now = Date.now();
      const stale = new Set(tasks.filter((t) => isStaleDecisionCard(t, t.assignee ? activity[t.assignee] : undefined, now)).map((t) => t.id));
      console.log(renderBoard(tasks, company, mine, stale));
    } else if (subcmd === "start") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw company task start <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = startTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m▶ started\x1b[0m ${t.id} \x1b[90m(in-progress)\x1b[0m: ${t.title}`);
    } else if (subcmd === "move") {
      // kobo-70 — re-file between the "parking" flow states backlog ⇄ todo ⇄ ready
      // (those without a dedicated pick-up verb; ready normally auto-promotes on
      // parent done, kobo-133 — manual move is the human override). in-progress/
      // review/done use start/review/done; blocked uses block. Pure state set — no
      // assignee change.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--reason": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const state = flags._[1] as TaskState | undefined;
      if (!id || !state) return { ok: false, error: "usage: maw company task move <id> <backlog|todo|ready|approve|need-answer|wait-for-deploy> [--reason <why> (approve/need-answer)]" };
      // kobo-189: `approve` (the human gate before done) joins the manual-override
      // targets — a human parks a reviewed card in Approve. kobo-218: `need-answer`
      // (Tony's DECISION queue) joins too — the owner parks a card there instead of
      // hold+@tony. in-progress/review/done still go via start/review/done; blocked
      // via block.
      if (state !== "backlog" && state !== "todo" && state !== "ready" && state !== "approve" && state !== "need-answer" && state !== "wait-for-deploy") {
        return { ok: false, error: `move target must be backlog, todo, ready, approve, need-answer or wait-for-deploy (in-progress/review/done via start/review/done; blocked via block)` };
      }
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      // kobo-191: moving INTO approve always carries a reason (the Approve lane is
      // Tony's queue — no reason-less park, whether via `approve` or `move`). Route
      // through approveTask so the single reason-enforcement point covers both.
      if (state === "approve") {
        if (!flags["--reason"] || !flags["--reason"].trim()) {
          return { ok: false, error: "--reason is required to move a card to approve (the Approve lane is Tony's queue — say why; or use `maw company task approve <id> --reason ...`)" };
        }
        const t = approveTask(company, id, me, flags["--reason"]);
        if (!t) return { ok: false, error: `task not found: ${id}` };
        console.log(`\x1b[32m✋ approve\x1b[0m ${t.id} \x1b[90m→ ${resolveReviewer(t)} (${t.reviewReason})\x1b[0m: ${t.title}`);
        return { ok: true };
      }
      // kobo-218: moving INTO need-answer carries a mandatory question (the lane is
      // Tony's decision queue — every card says WHAT it waits on). Same reason-park
      // discipline as approve; route through needAnswerTask (single enforcement point).
      if (state === "need-answer") {
        if (!flags["--reason"] || !flags["--reason"].trim()) {
          return { ok: false, error: "--reason is required to move a card to need-answer (Tony's decision queue — say what you need answered)" };
        }
        const t = needAnswerTask(company, id, me, flags["--reason"]);
        if (!t) return { ok: false, error: `task not found: ${id}` };
        console.log(`\x1b[36m❓ need-answer\x1b[0m ${t.id} \x1b[90m→ ${resolveReviewer(t)} (${t.reviewReason})\x1b[0m: ${t.title}`);
        return { ok: true };
      }
      const t = moveTask(company, id, state, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m⇄ moved\x1b[0m ${t.id} \x1b[90m(→ ${t.state})\x1b[0m: ${t.title}`);
    } else if (subcmd === "claim") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw company task claim <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = claimTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m⛏ claimed\x1b[0m ${t.id} \x1b[90m(in-progress)\x1b[0m: ${t.title}`);
    } else if (subcmd === "assign") {
      // Reassign = set a card's assignee to <who>. kobo-219: reassign is FRICTION —
      // displacing an existing owner requires --force-reassign (correction only:
      // wrong-assignee / board-lie fix). Bare reassign throws ReassignFrictionError,
      // surfaced by the outer catch. To hand off PART of the work, create a subtask
      // (parent keeps its assignee) — never reassign the parent (Board Truth rule 9).
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--to": String, "--force-reassign": Boolean }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const to = flags["--to"];
      if (!id || !to) return { ok: false, error: "usage: maw company task assign <id> --to <who> [--force-reassign]" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = assignTask(company, id, to, me, { force: Boolean(flags["--force-reassign"]) });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m→ assigned\x1b[0m ${t.id} \x1b[90m(${taskNextAction(t)})\x1b[0m: ${t.title}`);
      if (to !== me) {
        ping(to, `[task] ${me} handed you ${t.id}: ${t.title}`);
        console.log(`  \x1b[36m→ pinged ${to}\x1b[0m`);
      }
    } else if (subcmd === "done") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw company task done <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = completeTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[32m✔ done\x1b[0m ${t.id}: ${t.title}`);
    } else if (subcmd === "reject") {
      // Terminal "done but NOT accepted" (kobo-101) — like closing a PR without
      // merging. --reason is MANDATORY (why it wasn't accepted, kept to learn).
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--reason": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const reason = flags["--reason"]?.trim();
      if (!id) return { ok: false, error: 'usage: maw company task reject <id> --reason "<why>"' };
      if (!reason) return { ok: false, error: "--reason is required (why the card was not accepted — kept to learn)" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const before = readTask(company, id);
      const t = rejectTask(company, id, me, reason);
      if (!t) {
        // rejectTask returns null for not-found OR already-terminal — disambiguate.
        if (before && (before.state === "done" || before.state === "rejected")) {
          return { ok: false, error: `cannot reject ${id}: already ${before.state} (terminal)` };
        }
        return { ok: false, error: `task not found: ${id}` };
      }
      console.log(`\x1b[33m✗ rejected\x1b[0m ${t.id}: ${t.title} \x1b[90m— ${reason}\x1b[0m`);
      // Poke the doer whose work was rejected so they see the decision + reason.
      if (t.assignee && t.assignee !== me && t.assignee !== "any") {
        ping(t.assignee, `[task] ${me} rejected ${t.id}: ${reason}`);
        console.log(`  \x1b[36m→ pinged ${t.assignee}\x1b[0m`);
      }
    } else if (subcmd === "review") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--to": String, "--reason": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: 'usage: maw company task review <id> [--to <oracle>] [--reason "<text>"]' };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = reviewTask(company, id, me, { to: flags["--to"], reason: flags["--reason"] });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[35m⟳ review\x1b[0m ${t.id} \x1b[90m(${taskNextAction(t)})\x1b[0m: ${t.title}`);
      // kobo-144: notify the RESOLVED reviewer (reviewer field → creator → human),
      // not only an explicit --to — a plain `review` still pokes whoever's up.
      const rv = notifyReviewer(t, me);
      if (rv) console.log(`  \x1b[36m→ pinged ${rv}\x1b[0m`);
    } else if (subcmd === "hold") {
      // kobo-144: reviewer's brake — pull a card into review from any state so it
      // can't proceed until looked at (big change / unsure). Reviewer stays the
      // resolved chain (reviewer field → creator → human); notify them.
      // kobo-224: `--gate` = the reviewer judged it a Tony-gate (big) card → route
      // straight to the approve lane (Tony's queue) instead of review, replacing the
      // old hold+@tony. --reason is mandatory in the gate path (the Approve lane says
      // WHY). Pure lane move — approve = queue-for-bless only, NEVER auto-deploys.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--reason": String, "--gate": Boolean }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: 'usage: maw company task hold <id> [--reason "<text>"] [--gate]' };
      const gate = Boolean(flags["--gate"]);
      if (gate && (!flags["--reason"] || !flags["--reason"].trim())) {
        return { ok: false, error: "--reason is required with --gate (the Approve lane is Tony's queue — say why this card needs a human decision, e.g. money/hash/live/deploy/schema)" };
      }
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = holdTask(company, id, me, flags["--reason"], { gate });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      if (gate) {
        console.log(`\x1b[32m✋ approve\x1b[0m ${t.id} \x1b[90m→ ${resolveReviewer(t)} (${t.reviewReason})\x1b[0m: ${t.title} \x1b[90m[gated brake → Tony queue]\x1b[0m`);
      } else {
        console.log(`\x1b[35m⏸ hold\x1b[0m ${t.id} \x1b[90m→ ${resolveReviewer(t)}\x1b[0m: ${t.title}${flags["--reason"] ? ` \x1b[90m(${flags["--reason"]})\x1b[0m` : ""}`);
      }
      const hrv = notifyReviewer(t, me);
      if (hrv) console.log(`  \x1b[36m→ pinged ${hrv}\x1b[0m`);
    } else if (subcmd === "approve") {
      // kobo-191: the reviewer routes a BIG-work card (money/hash/live/deploy/
      // schema/cross-co/unsure — rule 12) review → approve, the human gate before
      // done. --reason is MANDATORY (the Approve lane is Tony's queue — every card
      // says WHY). Small work never comes here: the reviewer just closes it done.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--reason": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: 'usage: maw company task approve <id> --reason "<why it needs Tony>"' };
      if (!flags["--reason"] || !flags["--reason"].trim()) {
        return { ok: false, error: "--reason is required to approve (the Approve lane is Tony's queue — say why this card needs a human decision, e.g. money/hash/live/deploy/schema)" };
      }
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = approveTask(company, id, me, flags["--reason"]);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[32m✋ approve\x1b[0m ${t.id} \x1b[90m→ ${resolveReviewer(t)} (${t.reviewReason})\x1b[0m: ${t.title}`);
      const arv = notifyReviewer(t, me);
      if (arv) console.log(`  \x1b[36m→ pinged ${arv}\x1b[0m`);
    } else if (subcmd === "need-answer") {
      // kobo-235: the standalone `need-answer` verb — mirrors `approve` (kobo-218 wired
      // approve as a subcommand + the move path, but left need-answer only on the move
      // path, so `maw company task need-answer <id>` fell through to generic usage).
      // Routes the SAME needAnswerTask the move path uses — --reason is MANDATORY (the
      // Need-answer lane is Tony's decision queue; every card says WHAT it waits on).
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--reason": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: 'usage: maw company task need-answer <id> --reason "<what you need Tony to answer>"' };
      if (!flags["--reason"] || !flags["--reason"].trim()) {
        return { ok: false, error: "--reason is required for need-answer (the Need-answer lane is Tony's decision queue — say what decision/direction you need)" };
      }
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = needAnswerTask(company, id, me, flags["--reason"]);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m❓ need-answer\x1b[0m ${t.id} \x1b[90m→ ${resolveReviewer(t)} (${t.reviewReason})\x1b[0m: ${t.title}`);
      const nrv = notifyReviewer(t, me);
      if (nrv) console.log(`  \x1b[36m→ pinged ${nrv}\x1b[0m`);
    } else if (subcmd === "pr") {
      // Worker links the PR to the card directly (eq3-013): the ONLY prod path
      // that sets card.pr — `maw reply` can't (replier≠requester bug), so
      // pr-watch's open→review→done never fired. Reuse setTaskPr (state=review);
      // pr-watch's prOpenedReview is idempotent, so no double-transition.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--repo": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const prArg = flags._[1];
      if (!id || !prArg) return { ok: false, error: "usage: maw company task pr <id> <pr-number|pr-url> [--repo owner/name]" };
      // accept a bare number or a full github PR url (…/pull/<n>)
      const pr = /^\d+$/.test(prArg) ? Number(prArg) : parsePrNumber(prArg);
      if (!pr) return { ok: false, error: `invalid PR: ${prArg} (pass a number or a github PR url)` };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      // kobo-80: stamp the PR's repo so pr-watch can flip merge→done for cards
      // created without --repo. Priority: explicit --repo > repo in the PR url >
      // the git remote at CWD (the worker links from inside the repo's worktree).
      // setTaskPr only fills a MISSING repo — an existing card.repo always wins.
      // kobo-195: the CWD fallback is a foot-gun — running from an oracle dir (not
      // the target worktree) stamps card.repo = the oracle repo, so pr-watch polls
      // the wrong repo and the card never flips done. Trust it, but WARN loudly so
      // the caller can prefer --repo / the PR url when the guess is wrong.
      const explicitRepo = flags["--repo"] || parsePrRepo(prArg);
      const linkRepo = explicitRepo || currentRepoSlug();
      if (!explicitRepo && linkRepo) {
        console.log(`\x1b[33m⚠ repo derived from CWD git remote: ${linkRepo}\x1b[0m \x1b[90m— pass --repo owner/name (or a full PR url) if the PR lives elsewhere\x1b[0m`);
      }
      // kobo-99 DEFECT #1: a bare repo ("helm-charts", no owner) makes every
      // `gh pr list --repo <bare>` fail → the card is never polled and strands
      // silently. Reject at link time so the board never binds an unpollable repo.
      if (linkRepo && !/^[^/\s]+\/[^/\s]+$/.test(linkRepo)) {
        return { ok: false, error: `invalid repo: ${linkRepo} (use owner/name, e.g. meganechan/maw-js)` };
      }
      const t = setTaskPr(company, id, pr, me, linkRepo);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[35m⟳ review\x1b[0m ${t.id} \x1b[33m(PR #${pr})\x1b[0m${t.repo ? ` \x1b[90m${t.repo}\x1b[0m` : ""} \x1b[90m(${taskNextAction(t)})\x1b[0m: ${t.title}`);
      // kobo-144: PR up = card in review → poke the resolved reviewer to look.
      const prRv = notifyReviewer(t, me);
      if (prRv) console.log(`  \x1b[36m→ pinged ${prRv}\x1b[0m`);
    } else if (subcmd === "archive") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--days": Number }, 0);
      const me = await resolveActor(flags["--from"]);
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const id = flags._[0];
      if (id) {
        // Per-card archive by id (kobo-35): "checked" = human reviewed this done
        // card and signs it off the board. A positional id takes precedence over
        // the bulk --days sweep — the two forms never mix in one call.
        const t = archiveTask(company, id, me);
        if (!t) return { ok: false, error: `task not found: ${id}` };
        console.log(`\x1b[32m📦 archived\x1b[0m ${t.id}: ${t.title} \x1b[90m→ tasks/archive/\x1b[0m`);
      } else {
        const days = flags["--days"] ?? DEFAULT_ARCHIVE_DAYS;
        const archived = archiveOldDone(company, days, me);
        if (!archived.length) {
          console.log(`\x1b[90m○ nothing to archive\x1b[0m (no done card older than ${days}d)`);
        } else {
          console.log(`\x1b[32m📦 archived\x1b[0m ${archived.length} done card(s) older than ${days}d \x1b[90m→ tasks/archive/\x1b[0m`);
          for (const t of archived) console.log(`  \x1b[90m${t.id}\x1b[0m ${t.title}`);
        }
      }
    } else if (subcmd === "block") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--kind": String, "--reason": String, "--for": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: `usage: maw company task block <id> --kind <${BLOCK_KINDS.join("|")}> [--reason "<text>"] [--for tony|<oracle>|any]` };
      const kind = flags["--kind"] as BlockKind | undefined;
      if (!kind || !BLOCK_KINDS.includes(kind)) return { ok: false, error: `--kind must be one of: ${BLOCK_KINDS.join(", ")}` };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = blockTask(company, id, me, { kind, reason: flags["--reason"], for: flags["--for"] });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[31m⚑ blocked\x1b[0m ${t.id} \x1b[90m(${blockNextAction(t)})\x1b[0m: ${t.title}`);
      if (flags["--for"] && flags["--for"] !== me && flags["--for"] !== "any") {
        ping(flags["--for"], `[task] ${me} blocked ${t.id} → รอคุณ (${kind})${flags["--reason"] ? `: ${flags["--reason"]}` : ""}`);
        console.log(`  \x1b[36m→ pinged ${flags["--for"]}\x1b[0m`);
      }
    } else if (subcmd === "unblock") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw company task unblock <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = unblockTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[32m✔ unblocked\x1b[0m ${t.id} \x1b[90m(→ ${t.state})\x1b[0m: ${t.title}`);
    } else if (subcmd === "note") {
      // Append-only note (kobo-39) — the ONLY non-terminal verb: records mid-flight
      // truth (needs_input answer, decision loopback, progress) on the card so the
      // board reflects reality. id = first positional, text = the rest joined (so
      // an unquoted multi-word note still works, mirroring `add`'s title join).
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const noteText = flags._.slice(1).join(" ").trim();
      if (!id || !noteText) return { ok: false, error: 'usage: maw company task note <id> "<text>"' };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = noteTask(company, id, me, noteText);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m📝 note\x1b[0m ${t.id} \x1b[90m(${t.notes?.length} total)\x1b[0m: ${t.title}`);
      // comment = poke (kobo-46): a note by someone other than the assignee pokes
      // the assignee on task-events → coord pane. Shared with the web POST path.
      if (notifyTaskComment(t, me, noteText)) console.log(`  \x1b[36m→ pinged ${t.assignee}\x1b[0m`);
    } else if (subcmd === "edit") {
      // kobo-213 — reword a card's title/body IN PLACE (same id). Non-destructive:
      // deps/thread/comments/PR link/state/assignee untouched; the previous wording
      // is preserved in an append-only audit note (Nothing is Deleted). Does NOT
      // touch hash/idempotency — a card id is a counter, never derived from wording.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--title": String, "--body": String, "--reviewer": String, "--deploy-required": Boolean, "--no-deploy-required": Boolean }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: 'usage: maw company task edit <id> [--title "<new title>"] [--body "<new body>"] [--reviewer <who>] [--deploy-required | --no-deploy-required]' };
      if (flags["--deploy-required"] && flags["--no-deploy-required"]) {
        return { ok: false, error: "pass only one of --deploy-required / --no-deploy-required" };
      }
      const editDeployRequired = flags["--deploy-required"] ? true : (flags["--no-deploy-required"] ? false : undefined); // kobo-274 override
      if (flags["--title"] === undefined && flags["--body"] === undefined && flags["--reviewer"] === undefined && editDeployRequired === undefined) {
        return { ok: false, error: "nothing to edit — pass --title, --body, --reviewer, and/or --deploy-required/--no-deploy-required" };
      }
      const badTitle = badFlagValue("--title", flags["--title"]); if (badTitle) return { ok: false, error: badTitle };
      const badReviewer = badFlagValue("--reviewer", flags["--reviewer"]); if (badReviewer) return { ok: false, error: badReviewer };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = editTask(company, id, me, { title: flags["--title"], body: flags["--body"], reviewer: flags["--reviewer"], deployRequired: editDeployRequired });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m✎ edited\x1b[0m ${t.id}: ${t.title}`);
    } else if (subcmd === "epic") {
      // kobo-72 — set/clear a card's containment parent AFTER create (the axis
      // hand-edited JSON before). Reuses setTaskEpic (loop-guarded, re-links a
      // stale same-id dependency onto containment). `--clear` removes the parent.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--clear": Boolean }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const clear = flags["--clear"] === true;
      const epicId = clear ? undefined : flags._[1];
      if (!id || (!clear && !epicId)) return { ok: false, error: "usage: maw company task epic <id> <epicId|--clear>" };
      const badEpic = badFlagValue("epicId", epicId); if (badEpic) return { ok: false, error: badEpic };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = setTaskEpic(company, id, epicId, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(epicId
        ? `\x1b[36m↳ epic\x1b[0m ${t.id} ↳ ${epicId}: ${t.title}`
        : `\x1b[36m↳ epic\x1b[0m ${t.id} \x1b[90m(cleared)\x1b[0m: ${t.title}`);
    } else if (subcmd === "dep") {
      // kobo-134 — first-class dep-link management AFTER create (before this, the
      // dep axis was fixed at `add --parent` or hand-edited JSON). Edits parentIds
      // (ADR 0003 A) via setTaskDep: self/containment-conflict/cycle guarded,
      // idempotent both ways. blocked-by stays DERIVED at read — no state flip here.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const op = flags._[0];
      const id = flags._[1];
      const parentId = flags._[2];
      if ((op !== "add" && op !== "rm") || !id || !parentId) {
        return { ok: false, error: "usage: maw company task dep <add|rm> <id> <parentId>" };
      }
      const badDep = badFlagValue("parentId", parentId); if (badDep) return { ok: false, error: badDep };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = setTaskDep(company, id, parentId, op, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      const deps = t.parentIds?.join(", ") || "—";
      console.log(op === "add"
        ? `\x1b[36m🔗 dep\x1b[0m ${t.id} 🚫→ ${parentId} \x1b[90m(deps: ${deps})\x1b[0m: ${t.title}`
        : `\x1b[36m✂ dep\x1b[0m ${t.id} ✂ ${parentId} \x1b[90m(deps: ${deps})\x1b[0m: ${t.title}`);
      // soft hint — same contract as `add --parent`: an unresolvable parent still
      // links (backward-compat) but warns; the board shows the same faint ⚠.
      if (op === "add") {
        const resolve = parentStateResolver(company);
        if (resolve(parentId) === null) console.log(`  \x1b[33m⚠ parent ไม่พบ (ยัง link ได้): ${parentId}\x1b[0m`);
      }
    } else if (subcmd === "decompose") {
      // kobo-146 C7 (option B): materialize a CONFIRMED decomposition plan into
      // child cards + links. The LLM drafting lives in the /board-decompose skill
      // (out of scope) — this is the deterministic, testable executor (no LLM, no
      // secret). Plan rides --plan as a JSON array (runMaw is argv-only, no stdin):
      // each child { title, body?, deps?, assignee?, reviewer? } → a card under
      // <epicId>; deps link a sibling ($N, 0-indexed) or a literal card id.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--plan": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const epicId = flags._[0];
      const planArg = flags["--plan"];
      if (!epicId || !planArg) return { ok: false, error: `usage: maw company task decompose <epicId> --plan '<json array of {title,body?,deps?,assignee?,reviewer?}>'` };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      let children: DecomposeChild[];
      try {
        const parsed = JSON.parse(planArg);
        children = Array.isArray(parsed) ? parsed : parsed?.children; // accept [...] or { children: [...] }
      } catch (e) {
        return { ok: false, error: `invalid --plan JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!Array.isArray(children) || !children.length) {
        return { ok: false, error: "--plan must be a non-empty JSON array of children (or { children: [...] })" };
      }
      // Board rule 8 (soft): >10 children → should be a sub-epic. Warn, don't block.
      if (children.length > 10) console.log(`  \x1b[33m⚠ ${children.length} children — board rule: >10 ควรแตกเป็น sub-epic\x1b[0m`);
      let res;
      try {
        res = decomposeEpic(company, epicId, children, me);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      console.log(`\x1b[36m⛓ decompose\x1b[0m ${epicId} → \x1b[32m${res.created.length} created\x1b[0m${res.skipped.length ? `, ${res.skipped.length} skipped` : ""}`);
      for (const c of res.created) console.log(`  \x1b[32m✚\x1b[0m ${c.id} ${c.title}`);
      for (const s of res.skipped) console.log(`  \x1b[90m○ ${s.id} ${s.title} (มีอยู่แล้ว)\x1b[0m`);
      for (const w of res.depWarnings) console.log(`  \x1b[33m⚠ dep: ${w}\x1b[0m`);
      if (res.failed) {
        // Unhappy path — never silent: name what landed before the failure so a human can resume.
        console.log(`  \x1b[31m✗ failed at child #${res.failed.index} "${res.failed.title}": ${res.failed.error}\x1b[0m`);
        return { ok: false, error: `decompose stopped at child #${res.failed.index}: ${res.failed.error} (${res.created.length} card(s) created before the failure)` };
      }
    } else if (subcmd === "ask") {
      // ask-Tony 3-tier level 1 (kobo-126): a substantive question → its own
      // SUBCARD assigned to the answerer (default tony) + parent-linked, one shot.
      // `maw company task ask <parentId> "<question>" [--to who]`. Routes through
      // askTask → addTask (single write path). @tony/@human collapse to one queue.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--to": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const parentId = flags._[0];
      const question = flags._.slice(1).join(" ").trim();
      if (!parentId || !question) return { ok: false, error: 'usage: maw company task ask <parentId> "<question>" [--to tony]' };
      const badTo = badFlagValue("--to", flags["--to"]); if (badTo) return { ok: false, error: badTo };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const to = flags["--to"] || "tony"; // questions default to Tony's queue
      const t = askTask(company, parentId, question, to, me);
      if (!t) return { ok: false, error: `parent card not found: ${parentId}` };
      console.log(`\x1b[36m❓ ask\x1b[0m ${t.id} \x1b[90m↳ ${parentId}\x1b[0m → \x1b[32m@${t.assignee}\x1b[0m: ${t.title}`);
      if (t.assignee && t.assignee !== me) {
        ping(t.assignee, `[task] ${me} asks on ${parentId} (${t.id}): ${question}`);
        console.log(`  \x1b[36m→ pinged ${t.assignee}\x1b[0m`);
      }
    } else if (subcmd === "mentions") {
      // The @mention decision queue (kobo-126): unanswered @tony/@human (or --for
      // <who>) mentions across the board. Read-only — the SAME source the web
      // "mentions" badge reads. `maw company task mentions [--for tony]`.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--for": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const pending = pendingMentions(company, flags["--for"]);
      if (!pending.length) {
        console.log(`\x1b[90m○ no pending mentions\x1b[0m${flags["--for"] ? ` for ${flags["--for"]}` : ""}`);
      } else {
        console.log(`\x1b[1m@mentions\x1b[0m \x1b[90m(${pending.length}${flags["--for"] ? ` → ${flags["--for"]}` : ""})\x1b[0m`);
        for (const p of pending) {
          const one = p.text.replace(/\s+/g, " ").trim();
          console.log(`  \x1b[90m${p.id} ${p.commentId}\x1b[0m →\x1b[32m@${p.who}\x1b[0m \x1b[90m(by ${p.by})\x1b[0m: ${one.length > 70 ? one.slice(0, 67) + "…" : one}`);
        }
      }
    } else if (subcmd === "comment") {
      // Threaded ask/answer comment (kobo-140, Board Truth rule 10). id = card,
      // text = the rest joined (unquoted multi-word works, mirroring `note`).
      // `--reply-to <cid>` threads under an existing comment. @mentions in the text
      // ping the mentioned people (the ask channel) AND poke the assignee.
      // `maw company task comment <id> "<text>" [--reply-to c2]`.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--reply-to": String, "--tldr": String, "--ask": String, "--detail": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const text = flags._.slice(1).join(" ").trim();
      if (!id || !text) return { ok: false, error: 'usage: maw company task comment <id> "<text>" [--reply-to <cid>] [--tldr <..> --ask <..> --detail <..>]' };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      // kobo-263 GATE: a comment to @tony/@human must carry --tldr + --ask (structured
      // enforce, supersedes the kobo-262 nudge). agent↔agent → free. Reject before the write.
      const clarityErr = commentClarityError(text, flags["--tldr"], flags["--ask"], flags["--detail"]);
      if (clarityErr) return { ok: false, error: clarityErr };
      const t = commentTask(company, id, me, text, flags["--reply-to"], { tldr: flags["--tldr"], ask: flags["--ask"], detail: flags["--detail"] });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      const added = t.comments![t.comments!.length - 1];
      console.log(`\x1b[36m💬 comment\x1b[0m ${t.id} \x1b[90m(${added.id}${added.replyTo ? ` ↳ ${added.replyTo}` : ""})\x1b[0m: ${t.title}`);
      if (added.tldr) console.log(`  \x1b[1mTL;DR\x1b[0m ${added.tldr}${added.ask ? `\n  \x1b[36mask:\x1b[0m ${added.ask}` : ""}`); // structured echo (kobo-263)
      // @mentions route the ask (kobo-140): ping each mentioned person (not self).
      for (const who of parseMentions(text)) {
        if (who === me) continue;
        ping(who, `[task] ${me} @${who} on ${t.id} (${added.id}): ${text}`);
        console.log(`  \x1b[36m→ pinged @${who}\x1b[0m`);
      }
      // and poke the assignee (comment = nudge, kobo-46) unless they were @mentioned already or are self.
      // unassigned cards fall to the review chain inside notifyTaskComment (kobo-156).
      if (t.assignee !== me && !parseMentions(text).includes(t.assignee ?? "")) {
        if (notifyTaskComment(t, me, text)) console.log(`  \x1b[36m→ pinged ${t.assignee ?? "creator/reviewer"}\x1b[0m`);
      }
      // kobo-156: a reply also pings the AUTHOR of the comment it answers, so the
      // thread reaches the person addressed (in addition to the assignee poke above).
      if (added.replyTo) {
        const repliedTo = notifyCommentReply(t, added.replyTo, me);
        if (repliedTo) console.log(`  \x1b[36m→ pinged ${repliedTo} (reply)\x1b[0m`);
      }
    } else if (subcmd === "comments") {
      // List a card's comment thread (kobo-140), oldest first.
      // `maw company task comments <id>`.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw company task comments <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = readTask(company, id);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      const comments = t.comments ?? [];
      if (!comments.length) {
        console.log(`\x1b[90m○ no comments\x1b[0m on ${t.id}`);
      } else {
        console.log(`\x1b[1mcomments\x1b[0m \x1b[90m(${comments.length}) on ${t.id}\x1b[0m: ${t.title}`);
        for (const c of comments) {
          const one = c.text.replace(/\s+/g, " ").trim();
          const thread = c.replyTo ? `\x1b[90m↳${c.replyTo}\x1b[0m ` : "";
          console.log(`  \x1b[90m${c.id}\x1b[0m ${thread}\x1b[90m(${c.by})\x1b[0m: ${one.length > 70 ? one.slice(0, 67) + "…" : one}`);
        }
      }
    } else if (subcmd === "migrate-comments") {
      // One-shot migration (kobo-142, Phase C C3): copy question-notes (notes with
      // an @mention — the old ask channel) into comments[] on ACTIVE cards. COPY
      // (note kept), idempotent (fromNote marker). kobo-237: no resolve stamping.
      // `maw company task migrate-comments [--dry-run]`.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--dry-run": Boolean }, 0);
      const me = await resolveActor(flags["--from"]);
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const dryRun = flags["--dry-run"] === true;
      const res = migrateQuestionNotesToComments(company, { dryRun, by: me });
      console.log(`${dryRun ? "\x1b[33mDRY-RUN\x1b[0m " : ""}\x1b[36m↦ migrate\x1b[0m question-notes → comments: \x1b[32m${res.migrated} migrated\x1b[0m, ${res.skipped} already present \x1b[90m(${res.cards} card(s) with question-notes)\x1b[0m`);
      for (const o of res.outcomes) {
        console.log(`  \x1b[90m${o.id}\x1b[0m +${o.migrated}${o.skipped ? ` \x1b[90m(${o.skipped} skipped)\x1b[0m` : ""}`);
      }
    } else if (subcmd === "migrate-lanes") {
      // One-shot board-wide reconcile (kobo-257, epic 251 slice F): repair pre-fix
      // "2-lane" cards — a flow lane (review/in-progress) with a still-pending dep —
      // to their single correct lane (pending → blocked+prevState · cleared →
      // restore). Idempotent, non-destructive. Scans ALL companies (--company narrows).
      // `maw company task migrate-lanes [--dry-run] [--company <c>]`.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--dry-run": Boolean }, 0);
      const me = await resolveActor(flags["--from"]);
      const dryRun = flags["--dry-run"] === true;
      const res = reconcileTwoLaneCards({ dryRun, by: me, company: flags["--company"] || undefined });
      console.log(`${dryRun ? "\x1b[33mDRY-RUN\x1b[0m " : ""}\x1b[36m↦ reconcile\x1b[0m 2-lane cards: \x1b[32m${res.changed} corrected\x1b[0m \x1b[90m(${res.scanned} scanned across ${res.companies} company/ies)\x1b[0m`);
      for (const o of res.outcomes) {
        console.log(`  \x1b[90m${o.company}/${o.id}\x1b[0m ${o.from}→${o.to} \x1b[90m(${o.action})\x1b[0m`);
      }
    } else {
      return { ok: false, error: "usage: maw company task <add|ls|start|move|claim|assign|ask|mentions|comment|comments|migrate-comments|migrate-lanes|review|hold|pr|done|note|edit|epic|dep|decompose|archive|block|unblock> — see maw task for flags" };
    }

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  } finally {
    console.log = origLog;
  }
}

// cli-reorg kobo-26: the top-level `maw task` shim is REMOVED (Tony: hard-cut,
// no alias). This plugin is now a MODULE surface — `runTask` is imported by the
// company plugin (`maw company task`); agents use the maw_task MCP tool. There is
// no default handler and no cli command, so `maw task` → unknown command.
