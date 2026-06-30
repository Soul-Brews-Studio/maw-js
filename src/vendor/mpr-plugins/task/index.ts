/**
 * maw task — company task board CLI (ADR 0001 backbone).
 *
 *   maw task add "<title>" [--repo r] [--dept d] [--epic e] [--assignee a]
 *   maw task ls [--company c] [--mine]
 *   maw task claim <id>
 *   maw task done <id>
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
  claimTask,
  completeTask,
  listTasks,
  TASK_FLOW,
  type TaskRecord,
  type TaskState,
} from "../../../core/tasks/store";

export const command = {
  name: "task",
  description: "Company task board — create/claim/done first-class work items.",
};

function myOracle(): string {
  const cfg = loadConfig() as Record<string, unknown>;
  return (cfg.oracle as string) || process.env.CLAUDE_AGENT_NAME || "unknown";
}

function resolveCompany(flag?: string): string | null {
  return flag ?? companyOfOracle(myOracle()) ?? ((loadConfig() as Record<string, unknown>).company as string) ?? null;
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

/** "X รอ Y" — derived, never stored (ADR §4). */
function waitFor(t: TaskRecord): string | null {
  if (t.assignee && t.by !== t.assignee && t.state !== "done") return `${t.by}→${t.assignee}`;
  return null;
}

function renderBoard(tasks: TaskRecord[], company: string, mine: string | null): string {
  const lines: string[] = [];
  lines.push(`\x1b[36m▌ ${company} board\x1b[0m${mine ? ` \x1b[90m(--mine ${mine})\x1b[0m` : ""}`);
  if (!tasks.length) { lines.push("  \x1b[90m(no tasks)\x1b[0m"); return lines.join("\n"); }
  const order: TaskState[] = [...TASK_FLOW, "needs-attention"];
  for (const state of order) {
    const inState = tasks.filter((t) => t.state === state);
    if (!inState.length) continue;
    lines.push(`\n\x1b[1m${STATE_LABEL[state]}\x1b[0m \x1b[90m(${inState.length})\x1b[0m`);
    for (const t of inState) {
      const who = t.assignee ? `\x1b[32m@${t.assignee}\x1b[0m` : "\x1b[90m(unassigned)\x1b[0m";
      const wf = waitFor(t);
      const att = t.attention ? ` \x1b[33m⚑ ${t.attention.for}: ${t.attention.reason}\x1b[0m` : "";
      const pr = t.pr ? ` \x1b[33mPR#${t.pr}\x1b[0m` : "";
      lines.push(`  \x1b[90m${t.id}\x1b[0m ${t.title} ${who}${wf ? ` \x1b[90m[${wf}]\x1b[0m` : ""}${pr}${att}`);
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
        "--repo": String, "--dept": String, "--epic": String, "--assignee": String, "--company": String,
      }, 0);
      const title = flags._.join(" ").trim(); // positionals only — flag values excluded
      if (!title) return { ok: false, error: 'usage: maw task add "<title>" [--repo r --dept d --epic e --assignee a]' };
      const company = resolveCompany(flags["--company"]);
      if (!company) return { ok: false, error: "no company — pass --company <c> (could not resolve from config)" };
      const t = addTask({
        company, title, by: myOracle(),
        dept: flags["--dept"], epic: flags["--epic"], repo: flags["--repo"], assignee: flags["--assignee"] ?? null,
      });
      console.log(`\x1b[32m✚ created\x1b[0m ${t.id} \x1b[90m(${t.state})\x1b[0m: ${t.title}`);
      if (t.assignee && t.assignee !== myOracle()) {
        ping(t.assignee, `[task] ${myOracle()} assigned you ${t.id}: ${t.title}`);
        console.log(`  \x1b[36m→ pinged ${t.assignee}\x1b[0m`);
      }
    } else if (subcmd === "ls") {
      const flags = parseFlags(args.slice(1), { "--company": String }, 0);
      const company = resolveCompany(flags["--company"]);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const mine = args.includes("--mine") ? myOracle() : null;
      let tasks = listTasks(company);
      if (mine) tasks = tasks.filter((t) => t.assignee === mine);
      console.log(renderBoard(tasks, company, mine));
    } else if (subcmd === "claim") {
      const flags = parseFlags(args.slice(1), { "--company": String }, 0);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw task claim <id>" };
      const company = resolveCompany(flags["--company"]);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = claimTask(company, id, myOracle());
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[36m⛏ claimed\x1b[0m ${t.id} \x1b[90m(in-progress)\x1b[0m: ${t.title}`);
    } else if (subcmd === "done") {
      const flags = parseFlags(args.slice(1), { "--company": String }, 0);
      const id = flags._[0];
      if (!id) return { ok: false, error: "usage: maw task done <id>" };
      const company = resolveCompany(flags["--company"]);
      if (!company) return { ok: false, error: "no company — pass --company <c>" };
      const t = completeTask(company, id, myOracle());
      if (!t) return { ok: false, error: `task not found: ${id}` };
      console.log(`\x1b[32m✔ done\x1b[0m ${t.id}: ${t.title}`);
    } else {
      return { ok: false, error: "usage: maw task <add|ls|claim|done> — see maw task for flags" };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
