/**
 * maw task — company task board CLI (ADR 0001 backbone).
 *
 *   maw task add "<title>" [--repo r] [--dept d] [--epic e] [--assignee a] [--parent id,...] [--body "...md..."]
 *   maw task ls [--company c] [--mine]     # BLOCKED group for deps · ☑ N/M checklist progress from body
 *   maw task start <id>
 *   maw task claim <id>
 *   maw task done <id>
 *   maw task archive [--days N]      # sweep done cards older than N days → tasks/archive/
 *
 * State lives in the file-per-card store (companies/<c>/tasks/*.json); every
 * mutation also emits a worklog event so the activity feed stays the single
 * timeline. claim = set assignee + in-progress (ADR §1). create/assign is open
 * to anyone (transparency, not permission): `by` records the delegator and the
 * assignee is pinged on assignment (ADR §5).
 */

import { parseFlags, type InvokeContext, type InvokeResult } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { companyOfOracle } from "../../../core/worklog/company-scope";
import {
  addTask,
  archiveOldDone,
  checklistProgress,
  claimTask,
  completeTask,
  DEFAULT_ARCHIVE_DAYS,
  dependencyBlock,
  isOnBoard,
  listTasks,
  parentStateResolver,
  reviewTask,
  startTask,
  taskNextAction,
  TASK_FLOW,
  type DependencyBlock,
  type TaskRecord,
  type TaskState,
} from "../../../core/tasks/store";

export const command = {
  name: "task",
  description: "Company task board — create/claim/done first-class work items.",
};

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

/** Best-effort ping (assignee notified on assignment) — never blocks the CLI. */
function ping(target: string, message: string): void {
  try {
    Bun.spawn(["maw", "hey", target, message], { stdout: "ignore", stderr: "ignore" });
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
  "needs-attention": "NEEDS-ATTENTION",
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

  // Derived blocked-by-dependency (ADR 0003 A) — computed at read, never stored.
  // A card with any pending parent is pulled OFF the flow into BLOCKED.
  const resolveParent = parentStateResolver(company);
  const dep = new Map(tasks.map((t) => [t.id, dependencyBlock(t, resolveParent)] as const));
  const isBlocked = (t: TaskRecord) => dep.get(t.id)!.blockedBy.length > 0;
  const flow = tasks.filter((t) => !isBlocked(t));
  const blocked = tasks.filter(isBlocked);

  const order: TaskState[] = [...TASK_FLOW, "needs-attention"];
  for (const state of order) {
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
      lines.push(`    \x1b[90m↳\x1b[0m \x1b[31m🚫 รอ: ${dep.get(t.id)!.blockedBy.join(", ")}\x1b[0m`);
      const m = missingLine(dep.get(t.id)!); if (m) lines.push(m);
    }
  }
  return lines.join("\n");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { if (ctx.writer) ctx.writer(...a); else logs.push(a.map(String).join(" ")); };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const subcmd = args[0];

    if (subcmd === "add") {
      const flags = parseFlags(args.slice(1), {
        "--repo": String, "--dept": String, "--epic": String, "--assignee": String, "--company": String, "--from": String, "--parent": [String], "--body": String,
      }, 0);
      const me = await resolveActor(flags["--from"]);
      const title = flags._.join(" ").trim(); // positionals only — flag values excluded
      if (!title) return { ok: false, error: 'usage: maw task add "<title>" [--repo r --dept d --epic e --assignee a --parent id --body text]' };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c> (could not resolve from config)" };
      // --parent repeatable AND comma-separated: --parent a,b --parent c → [a,b,c]
      const parentIds = (flags["--parent"] ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
      const t = addTask({
        company, title, by: me,
        dept: flags["--dept"], epic: flags["--epic"], repo: flags["--repo"], assignee: flags["--assignee"] ?? null,
        parentIds, body: flags["--body"],
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
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const mine = args.includes("--mine") ? me : null;
      // Board shows done only within the window (ADR 0002 P3) — old done ages
      // off here even before the archive sweep physically moves it.
      let tasks = listTasks(company).filter((t) => isOnBoard(t));
      if (mine) tasks = tasks.filter((t) => t.assignee === mine);
      console.log(renderBoard(tasks, company, mine));
    } else if (subcmd === "start") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw task start <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = startTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m▶ started\x1b[0m ${t.id} \x1b[90m(in-progress)\x1b[0m: ${t.title}`);
    } else if (subcmd === "claim") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw task claim <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = claimTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m⛏ claimed\x1b[0m ${t.id} \x1b[90m(in-progress)\x1b[0m: ${t.title}`);
    } else if (subcmd === "done") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw task done <id>" };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = completeTask(company, id, me);
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[32m✔ done\x1b[0m ${t.id}: ${t.title}`);
    } else if (subcmd === "review") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--to": String, "--reason": String, "--from": String }, 0);
      const me = await resolveActor(flags["--from"]);
      const id = flags._[0];
      if (!id) return { ok: false, error: 'usage: maw task review <id> [--to <oracle>] [--reason "<text>"]' };
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = reviewTask(company, id, me, { to: flags["--to"], reason: flags["--reason"] });
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[35m⟳ review\x1b[0m ${t.id} \x1b[90m(${taskNextAction(t)})\x1b[0m: ${t.title}`);
      if (flags["--to"] && flags["--to"] !== me) {
        ping(flags["--to"], `[task] ${me} ขอให้ review ${t.id}: ${t.title}${flags["--reason"] ? ` — ${flags["--reason"]}` : ""}`);
        console.log(`  \x1b[36m→ pinged ${flags["--to"]}\x1b[0m`);
      }
    } else if (subcmd === "archive") {
      const flags = parseFlags(args.slice(1), { "--company": String, "--from": String, "--days": Number }, 0);
      const me = await resolveActor(flags["--from"]);
      const company = resolveCompany(flags["--company"], me);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const days = flags["--days"] ?? DEFAULT_ARCHIVE_DAYS;
      const archived = archiveOldDone(company, days, me);
      if (!archived.length) {
        console.log(`\x1b[90m○ nothing to archive\x1b[0m (no done card older than ${days}d)`);
      } else {
        console.log(`\x1b[32m📦 archived\x1b[0m ${archived.length} done card(s) older than ${days}d \x1b[90m→ tasks/archive/\x1b[0m`);
        for (const t of archived) console.log(`  \x1b[90m${t.id}\x1b[0m ${t.title}`);
      }
    } else {
      return { ok: false, error: "usage: maw task <add|ls|start|claim|review|done|archive> — see maw task for flags" };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
