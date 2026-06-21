import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { parseFlags } from "maw-js/sdk";
import {
  createCompany, deleteCompany, listCompanies, loadCompany,
  addDepartment, removeDepartment,
  assignMember, removeMember, departmentMembers,
  type DeptRole,
} from "./company-helpers";

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
  logs.push("usage: maw company <create|add-dept|ls|tree|rm-dept|delete>");
  return `unknown subcommand: ${sub}`;
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
  logs.push("usage: maw dept <assign|members|remove>");
  return `unknown subcommand: ${sub}`;
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
    const err = asDept ? runDept(args, logs) : runCompany(args, logs);
    const output = logs.join("\n");
    if (ctx.writer && output) ctx.writer(output);
    // When a writer streamed the output, return undefined so the dispatcher
    // does not reprint it (see ping plugin). With no writer, return output.
    const returned = ctx.writer ? undefined : output || undefined;
    if (err) return { ok: false, error: err, output: returned };
    return { ok: true, output: returned };
  } catch (e: any) {
    const output = logs.join("\n");
    if (ctx.writer && output) ctx.writer(output);
    const returned = ctx.writer ? undefined : output || undefined;
    return { ok: false, error: output || e.message, output: returned };
  }
}
