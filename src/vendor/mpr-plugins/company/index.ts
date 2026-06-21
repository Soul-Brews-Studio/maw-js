import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { parseFlags } from "maw-js/sdk";
import {
  createCompany, deleteCompany, listCompanies, loadCompany,
  addDepartment, removeDepartment,
  assignMember, removeMember, departmentMembers,
  type DeptRole,
} from "./company-helpers";
import { attachToDept } from "./company-attach";
import {
  deptLearn, deptKnowledge, deptShare, deptSync,
} from "./company-knowledge";

export const command = {
  name: ["company", "dept"],
  description: "Logical company > department > oracle layer — registry, assign, tree.",
};

const G = "\x1b[32m"; // green
const C = "\x1b[36m"; // cyan
const Y = "\x1b[33m"; // yellow
const D = "\x1b[90m"; // dim
const R = "\x1b[0m";  // reset

function parseRole(raw: unknown): DeptRole {
  const r = String(raw ?? "dev").toLowerCase();
  if (r !== "lead" && r !== "dev" && r !== "qa") {
    throw new Error(`invalid --role '${r}' — must be one of: lead, dev, qa`);
  }
  return r;
}

// Each verb-runner pushes user-facing lines into `logs` and returns an error
// string on failure, or undefined on success. The handler flushes `logs` once.

// ─── company verbs ───────────────────────────────────────────────────────────

function runCompany(args: string[], logs: string[]): string | undefined {
  const sub = args[0]?.toLowerCase();

  if (sub === "create" || sub === "new") {
    const name = args[1];
    if (!name) { logs.push("usage: maw company create <name>"); return "name required"; }
    createCompany(name);
    logs.push(`${G}✓${R} company '${name}' created`);
    return;
  }

  if (sub === "add-dept") {
    const flags = parseFlags(args, { "--lead": String }, 1);
    const company = flags._[0];
    const dept = flags._[1];
    if (!company || !dept) {
      logs.push("usage: maw company add-dept <company> <dept> [--lead <oracle>]");
      return "company and dept required";
    }
    addDepartment(company, dept, { lead: flags["--lead"] as string | undefined });
    logs.push(`${G}✓${R} department '${dept}' added to '${company}'${flags["--lead"] ? ` (lead: ${flags["--lead"]})` : ""}`);
    return;
  }

  if (sub === "rm-dept") {
    const company = args[1];
    const dept = args[2];
    if (!company || !dept) {
      logs.push("usage: maw company rm-dept <company> <dept>");
      return "company and dept required";
    }
    removeDepartment(company, dept);
    logs.push(`${G}✓${R} department '${dept}' removed from '${company}'`);
    return;
  }

  if (sub === "delete" || sub === "rm") {
    const name = args[1];
    if (!name) { logs.push("usage: maw company delete <name>"); return "name required"; }
    deleteCompany(name);
    logs.push(`${G}✓${R} company '${name}' deleted`);
    return;
  }

  if (sub === "tree") {
    renderTree(args[1], logs);
    return;
  }

  if (!sub || sub === "ls" || sub === "list") {
    renderList(logs);
    return;
  }

  logs.push(`unknown company subcommand: ${sub}`);
  logs.push("usage: maw company <create|add-dept|ls|tree|attach|rm-dept|delete>");
  return `unknown subcommand: ${sub}`;
}

// ─── operate verb: attach (async — shells out to maw attach / maw bud) ───────

async function runAttach(args: string[], logs: string[]): Promise<string | undefined> {
  // args[0] === "attach"; positional company/dept follow it.
  const flags = parseFlags(args, { "--new": Boolean, "--role": String }, 1);
  const company = flags._[0];
  const dept = flags._[1];
  if (!company || !dept) {
    logs.push("usage: maw company attach <company> <dept> [--new] [--role lead|dev|qa]");
    return "company and dept required";
  }
  const role = flags["--role"] !== undefined ? parseRole(flags["--role"]) : "dev";
  const outcome = await attachToDept(company, dept, {
    isNew: Boolean(flags["--new"]),
    role,
  });

  switch (outcome.kind) {
    case "no-company":
      logs.push(`${Y}⚠${R} no company matches '${outcome.input}'`);
      logs.push(`  ${D}see: maw company ls${R}`);
      return `company '${outcome.input}' not found`;
    case "no-dept":
      logs.push(`${Y}⚠${R} no department in '${outcome.company}' matches '${outcome.input}'`);
      logs.push(`  ${D}see: maw company tree ${outcome.company}${R}`);
      return `department '${outcome.input}' not found`;
    case "attached":
      // maw attach streamed its own output to the inherited terminal; just note it.
      logs.push(`${G}✓${R} ${outcome.company}/${outcome.dept} → ${outcome.oracle} ${D}(${outcome.status})${R}`);
      return;
    case "budded":
      logs.push(`${G}✓${R} budded new member ${outcome.oracle} → ${outcome.company}/${outcome.dept}`);
      return;
    case "all-busy": {
      const { report } = outcome;
      logs.push(`${Y}⚠${R} ${outcome.company}/${outcome.dept} full (${report.busy}/${report.total} busy)`);
      if (report.sleeping > 0) {
        logs.push(`  ${D}sleeping (wakeable):${R} ${report.sleepingMembers.join(", ")}`);
        logs.push(`  ${D}→ wake one: maw wake ${report.sleepingMembers[0]}${R}`);
      }
      logs.push(`  ${D}→ wait for an idle member, or spawn a new one: maw company attach ${outcome.company} ${outcome.dept} --new${R}`);
      return `${outcome.company}/${outcome.dept} full`;
    }
  }
}

function renderList(logs: string[]): void {
  const companies = listCompanies();
  if (companies.length === 0) {
    logs.push(`\n  No companies. Run ${C}maw company create <name>${R}\n`);
    return;
  }
  logs.push(`\n  ${C}Companies${R} (${companies.length})\n`);
  for (const c of companies) {
    const depts = Object.entries(c.departments);
    logs.push(`  ${G}●${R} ${c.name}${R}  ${D}(${depts.length} dept${depts.length === 1 ? "" : "s"})${R}`);
    for (const [name, d] of depts) {
      const lead = d.lead ? `lead: ${d.lead}` : "no lead";
      logs.push(`      ${D}└─${R} ${name.padEnd(16)} ${D}${String(d.members.length).padStart(2)} member${d.members.length === 1 ? " " : "s"} · ${lead}${R}`);
    }
  }
  logs.push("");
}

function renderTree(only: string | undefined, logs: string[]): void {
  const companies = (only ? [loadCompany(only)] : listCompanies()).filter(Boolean) as ReturnType<typeof listCompanies>;
  if (only && companies.length === 0) {
    logs.push(`${Y}⚠${R} company '${only}' not found`);
    return;
  }
  if (companies.length === 0) {
    logs.push(`\n  No companies. Run ${C}maw company create <name>${R}\n`);
    return;
  }
  logs.push("");
  for (const c of companies) {
    logs.push(`  ${C}${c.name}${R}`);
    const depts = Object.entries(c.departments);
    depts.forEach(([name, d], di) => {
      const last = di === depts.length - 1;
      const branch = last ? "└─" : "├─";
      const pad = last ? "   " : "│  ";
      logs.push(`  ${D}${branch}${R} ${name} ${D}(${d.kbTag})${R}`);
      d.members.forEach((m, mi) => {
        const mlast = mi === d.members.length - 1;
        const mbranch = mlast ? "└─" : "├─";
        const roleTag = m.role === "lead" ? `${Y}lead${R}` : `${D}${m.role}${R}`;
        logs.push(`  ${D}${pad}${mbranch}${R} ${m.oracle} ${D}·${R} ${roleTag}`);
      });
      if (d.members.length === 0) logs.push(`  ${D}${pad}└─ (no members)${R}`);
    });
    if (depts.length === 0) logs.push(`  ${D}└─ (no departments)${R}`);
  }
  logs.push("");
}

// ─── dept verbs ──────────────────────────────────────────────────────────────

function runDept(args: string[], logs: string[]): string | undefined {
  const sub = args[0]?.toLowerCase();

  if (sub === "assign") {
    const flags = parseFlags(args, { "--role": String }, 1);
    const company = flags._[0];
    const dept = flags._[1];
    const oracle = flags._[2];
    if (!company || !dept || !oracle) {
      logs.push("usage: maw dept assign <company> <dept> <oracle> [--role lead|dev|qa]");
      return "company, dept, oracle required";
    }
    const role = parseRole(flags["--role"]);
    const res = assignMember(company, dept, oracle, role);
    if (res.naming.collision) {
      logs.push(`${Y}⚠${R} '${oracle}' is already in ${company}/${dept} — re-assign (role → ${role}).`);
      logs.push(`  ${D}suggested convention: ${res.naming.suggestion}${R}`);
    }
    logs.push(`${G}✓${R} ${res.alreadyMember ? "updated" : "assigned"} ${oracle} → ${company}/${dept} (${role})`);
    return;
  }

  if (sub === "members") {
    const company = args[1];
    const dept = args[2];
    if (!company || !dept) {
      logs.push("usage: maw dept members <company> <dept>");
      return "company and dept required";
    }
    const members = departmentMembers(company, dept);
    logs.push(`\n  ${C}${company}/${dept}${R}  ${D}(${members.length} member${members.length === 1 ? "" : "s"})${R}\n`);
    if (members.length === 0) {
      logs.push(`  ${D}(no members) — maw dept assign ${company} ${dept} <oracle>${R}\n`);
      return;
    }
    for (const m of members) {
      const roleTag = m.role === "lead" ? `${Y}lead${R}` : `${D}${m.role}${R}`;
      logs.push(`  ${G}●${R} ${m.oracle.padEnd(24)} ${roleTag}`);
    }
    logs.push("");
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const company = args[1];
    const dept = args[2];
    const oracle = args[3];
    if (!company || !dept || !oracle) {
      logs.push("usage: maw dept remove <company> <dept> <oracle>");
      return "company, dept, oracle required";
    }
    removeMember(company, dept, oracle);
    logs.push(`${G}✓${R} removed ${oracle} from ${company}/${dept}`);
    return;
  }

  logs.push(`unknown dept subcommand: ${sub}`);
  logs.push("usage: maw dept <assign|members|remove|learn|knowledge|share|sync>");
  return `unknown subcommand: ${sub}`;
}

// ─── async dept verbs: knowledge exchange (KB HTTP / soul-sync / hey) ─────────

/** Dept verbs that perform I/O (HTTP / shell-out) and must be awaited. */
const ASYNC_DEPT_VERBS = new Set(["learn", "knowledge", "share", "sync"]);

async function runDeptAsync(args: string[], logs: string[]): Promise<string | undefined> {
  const sub = args[0]?.toLowerCase();

  if (sub === "learn") {
    const company = args[1];
    const dept = args[2];
    const knowledge = args.slice(3).join(" ").trim();
    if (!company || !dept || !knowledge) {
      logs.push('usage: maw dept learn <company> <dept> "<knowledge>"');
      return "company, dept, knowledge required";
    }
    const res = await deptLearn(company, dept, knowledge);
    if (!res.ok) { logs.push(`${Y}⚠${R} ${res.message}`); return res.message; }
    logs.push(`${G}✓${R} ${res.message}`);
    return;
  }

  if (sub === "knowledge") {
    const company = args[1];
    const dept = args[2];
    const query = args.slice(3).join(" ").trim() || undefined;
    if (!company || !dept) {
      logs.push("usage: maw dept knowledge <company> <dept> [<query>]");
      return "company and dept required";
    }
    const res = await deptKnowledge(company, dept, query);
    if (!res.ok) { logs.push(`${Y}⚠${R} ${res.message}`); return res.message; }
    logs.push(`\n  ${C}${company}/${dept}${R}  ${D}${res.message}${R}\n`);
    if (res.results.length === 0) {
      logs.push(`  ${D}(no dept knowledge${query ? ` matching "${query}"` : ""})${R}\n`);
      return;
    }
    for (const r of res.results) {
      const snippet = r.content.replace(/\s+/g, " ").trim().slice(0, 160);
      logs.push(`  ${G}●${R} ${snippet}`);
      logs.push(`      ${D}${r.source_file} · score ${r.score.toFixed(3)}${R}`);
    }
    logs.push("");
    return;
  }

  if (sub === "share") {
    const company = args[1];
    const dept = args[2];
    const message = args.slice(3).join(" ").trim();
    if (!company || !dept || !message) {
      logs.push('usage: maw dept share <company> <dept> "<msg>"');
      return "company, dept, message required";
    }
    const reports = await deptShare(company, dept, message);
    if (reports.length === 0) {
      logs.push(`${Y}⚠${R} ${company}/${dept} has no members to share with`);
      return `${company}/${dept} has no members`;
    }
    const sent = reports.filter((r) => r.ok).length;
    logs.push(`\n  ${C}${company}/${dept}${R}  ${D}shared to ${sent}/${reports.length} member(s)${R}\n`);
    for (const r of reports) {
      if (r.ok) logs.push(`  ${G}✓${R} ${r.oracle}`);
      else logs.push(`  ${Y}✗${R} ${r.oracle} ${D}(${r.detail ?? "failed"})${R}`);
    }
    logs.push("");
    return sent === 0 ? "no members reached" : undefined;
  }

  if (sub === "sync") {
    const company = args[1];
    const dept = args[2];
    if (!company || !dept) {
      logs.push("usage: maw dept sync <company> <dept>");
      return "company and dept required";
    }
    const res = await deptSync(company, dept);
    if (res.lead === null) {
      logs.push(`${Y}⚠${R} no lead set for ${company}/${dept} — set one: maw dept assign ${company} ${dept} <oracle> --role lead`);
      return `no lead set for ${company}/${dept}`;
    }
    logs.push(`\n  ${C}${company}/${dept}${R}  ${D}soul-sync FROM lead '${res.lead}' (push lead.ψ → members)${R}\n`);
    if (res.reports.length === 0) {
      logs.push(`  ${D}(no members besides the lead)${R}\n`);
      return;
    }
    const ok = res.reports.filter((r) => r.ok).length;
    for (const r of res.reports) {
      if (r.ok) logs.push(`  ${G}✓${R} ${res.lead} → ${r.oracle}`);
      else logs.push(`  ${Y}✗${R} ${res.lead} → ${r.oracle} ${D}(${r.detail ?? "failed"})${R}`);
    }
    logs.push("");
    return ok === 0 ? "no members synced" : undefined;
  }

  // Should not reach here (gated by ASYNC_DEPT_VERBS), but be safe.
  return runDept(args, logs);
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  try {
    if (ctx.source !== "cli") {
      return { ok: false, error: "company plugin is CLI-only" };
    }
    const args = ctx.args as string[];
    // Route by the matched surface: `maw dept ...` → dept verbs, else company.
    const asDept = ctx.matchedName === "dept";
    // `attach` is an async company verb (shells out to maw attach / maw bud).
    const isAttach = !asDept && args[0]?.toLowerCase() === "attach";
    // learn/knowledge/share/sync are async dept verbs (KB HTTP / soul-sync / hey).
    const isAsyncDept = asDept && ASYNC_DEPT_VERBS.has(args[0]?.toLowerCase() ?? "");
    const err = isAttach
      ? await runAttach(args, logs)
      : isAsyncDept
        ? await runDeptAsync(args, logs)
        : asDept
          ? runDept(args, logs)
          : runCompany(args, logs);
    const output = logs.join("\n");
    if (ctx.writer && output) ctx.writer(output);
    // When a writer streamed the output, return undefined so the dispatcher
    // does not reprint it (see ping plugin). With no writer, return output.
    const returned = ctx.writer ? undefined : output || undefined;
    // When output already carries the message (streamed or returned),
    // suppress `error` so the dispatcher doesn't reprint it (see #15).
    if (err) return { ok: false, error: output ? undefined : err, output: returned };
    return { ok: true, output: returned };
  } catch (e: any) {
    const output = logs.join("\n");
    if (ctx.writer && output) ctx.writer(output);
    const returned = ctx.writer ? undefined : output || undefined;
    return { ok: false, error: output ? undefined : e.message, output: returned };
  }
}
