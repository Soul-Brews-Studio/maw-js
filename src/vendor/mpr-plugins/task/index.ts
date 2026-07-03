/**
 * maw company task — company task board CLI (ADR 0001 backbone; cli-reorg ADR
 * docs/company/0001). Agents use the maw_task MCP tool; the top-level `maw task`
 * is a deprecation shim (one release) that forwards to the shared runner.
 *
 *   maw company task add "<title>" [--repo r] [--dept d] [--epic e] [--assignee a] [--parent id,...] [--body "...md..."]
 *   maw company task ls [--company c] [--mine] [--for <who>]  # BLOCKED group · ☑ N/M checklist · --for = decision queue
 *   maw company task start <id>
 *   maw company task claim <id>
 *   maw company task pr <id> <pr-number>   # worker links the PR → card.pr + review (pr-watch drives merge→done)
 *   maw company task done <id>             # also clears an explicit block
 *   maw company task note <id> "<text>"    # append-only note — mid-flight truth (kobo-39)
 *   maw company task archive <id>          # per-card: human reviewed this done card → tasks/archive/ (kobo-35)
 *   maw company task archive [--days N]    # bulk: sweep done cards older than N days → tasks/archive/
 *   maw company task block <id> --kind <dependency|needs_input|capability|transient> [--reason "..."] [--for tony|<oracle>|any]
 *   maw company task unblock <id>          # restore prevState
 *
 * State lives in the file-per-card store (companies/<c>/tasks/*.json); every
 * mutation also emits a worklog event so the activity feed stays the single
 * timeline. claim = set assignee + in-progress (ADR §1). create/assign is open
 * to anyone (transparency, not permission): `by` records the delegator and the
 * assignee is pinged on assignment (ADR §5).
 */

import { parseFlags } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { companyOfOracle } from "../../../core/worklog/company-scope";
import {
  addTask,
  archiveOldDone,
  archiveTask,
  BLOCK_KINDS,
  blockNextAction,
  blockTask,
  checklistProgress,
  claimTask,
  completeTask,
  DEFAULT_ARCHIVE_DAYS,
  dependencyBlock,
  isOnBoard,
  listTasks,
  needsOwner,
  noteTask,
  parentStateResolver,
  parsePrNumber,
  parsePrRepo,
  reviewTask,
  setTaskEpic,
  setTaskPr,
  moveTask,
  startTask,
  taskNextAction,
  TASK_FLOW,
  unblockTask,
  type BlockKind,
  type DependencyBlock,
  type TaskKind,
  type TaskRecord,
  type TaskState,
} from "../../../core/tasks/store";
import { notifyTaskComment } from "../../../core/tasks/notify";

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
  return flag ?? companyOfOracle(me) ?? ((loadConfig() as Record<string, unknown>).company as string) ?? null;
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
  "in-progress": "IN-PROGRESS",
  "review": "REVIEW",
  "done": "DONE",
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

function renderBoard(tasks: TaskRecord[], company: string, mine: string | null): string {
  const lines: string[] = [];
  lines.push(`\x1b[36m▌ ${company} board\x1b[0m${mine ? ` \x1b[90m(--mine ${mine})\x1b[0m` : ""}`);
  if (!tasks.length) { lines.push("  \x1b[90m(no tasks)\x1b[0m"); return lines.join("\n"); }

  // Off-flow = explicit block (ADR 0003 B, state="blocked") OR derived
  // blocked-by-dependency (ADR 0003 A) OR derived needs-owner (eq3-011 kobo-14,
  // todo+unassigned). All three share ONE group — computed at read.
  const resolveParent = parentStateResolver(company);
  const dep = new Map(tasks.map((t) => [t.id, dependencyBlock(t, resolveParent)] as const));
  const isDepBlocked = (t: TaskRecord) => dep.get(t.id)!.blockedBy.length > 0;
  const offFlow = (t: TaskRecord) => t.state === "blocked" || isDepBlocked(t) || needsOwner(t);
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
      const m = missingLine(dep.get(t.id)!); if (m) lines.push(m);
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
        "--repo": String, "--dept": String, "--epic": String, "--assignee": String, "--company": String, "--from": String, "--parent": [String], "--body": String, "--state": String, "--kind": String,
      }, 0);
      const me = await resolveActor(flags["--from"]);
      const title = flags._.join(" ").trim(); // positionals only — flag values excluded
      if (!title) return { ok: false, error: 'usage: maw company task add "<title>" [--kind epic|task --repo r --dept d --epic e --assignee a --parent id --body text --state backlog|todo]' };
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
      const addState = flags["--state"] as TaskState | undefined;
      if (addState && addState !== "backlog" && addState !== "todo") {
        return { ok: false, error: `--state must be backlog or todo (in-progress/review/done via start/review/done)` };
      }
      // --parent repeatable AND comma-separated: --parent a,b --parent c → [a,b,c]
      const parentIds = (flags["--parent"] ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
      const t = addTask({
        company, title, by: me, kind: addKind,
        dept: flags["--dept"], epic: flags["--epic"], repo: flags["--repo"], assignee: flags["--assignee"] ?? null,
        parentIds, body: flags["--body"], state: addState,
      });
      console.log(`\x1b[32m✚ created\x1b[0m ${t.id} \x1b[90m(${t.state})\x1b[0m: ${t.title}`);
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
      console.log(renderBoard(tasks, company, mine));
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
      // kobo-70 — re-file between the "parking" flow states backlog ⇄ todo (the two
      // without a dedicated pick-up verb). in-progress/review/done use start/review/
      // done; blocked uses block. Pure state set — no assignee change.
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      const state = flags._[1] as TaskState | undefined;
      if (!id || !state) return { ok: false, error: "usage: maw company task move <id> <backlog|todo>" };
      if (state !== "backlog" && state !== "todo") {
        return { ok: false, error: `move target must be backlog or todo (in-progress/review/done via start/review/done; blocked via block)` };
      }
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
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
      if (flags["--to"] && flags["--to"] !== me) {
        ping(flags["--to"], `[task] ${me} ขอให้ review ${t.id}: ${t.title}${flags["--reason"] ? ` — ${flags["--reason"]}` : ""}`);
        console.log(`  \x1b[36m→ pinged ${flags["--to"]}\x1b[0m`);
      }
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
      const linkRepo = flags["--repo"] || parsePrRepo(prArg) || currentRepoSlug();
      const t = setTaskPr(company, id, pr, me, linkRepo);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[35m⟳ review\x1b[0m ${t.id} \x1b[33m(PR #${pr})\x1b[0m${t.repo ? ` \x1b[90m${t.repo}\x1b[0m` : ""} \x1b[90m(${taskNextAction(t)})\x1b[0m: ${t.title}`);
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
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = setTaskEpic(company, id, epicId, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(epicId
        ? `\x1b[36m↳ epic\x1b[0m ${t.id} ↳ ${epicId}: ${t.title}`
        : `\x1b[36m↳ epic\x1b[0m ${t.id} \x1b[90m(cleared)\x1b[0m: ${t.title}`);
    } else {
      return { ok: false, error: "usage: maw company task <add|ls|start|move|claim|review|pr|done|note|epic|archive|block|unblock> — see maw task for flags" };
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
