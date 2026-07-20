import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { parseFlags } from "maw-js/sdk";
import {
  createCompany, deleteCompany, listCompanies, loadCompany,
  addDepartment, removeDepartment,
  assignMember, removeMember, departmentMembers,
  type DeptRole,
} from "./company-helpers";
import { attachToDept } from "./company-attach";
import { syncCompanyPolicy } from "./company-sync";
import { migrateCompanyPolicy } from "./company-migrate";
import { clearPolicyAttach } from "../../../core/policy/attach-store";
import {
  provisionOracleHooks, pruneOracleHooks, hooksStatusForOracle, setupWorklogHooks,
} from "../../../core/worklog/hook-setup";
import { companyOracles } from "../../../core/worklog/company-scope";
import {
  deptLearn, deptKnowledge, deptShare, deptSync,
} from "./company-knowledge";
// cli-reorg (ADR docs/company/0001): `maw company home|worklog|task` delegate to
// their plugins' shared runners — one logic copy, no duplication. Sibling-plugin
// imports (not core/* reaches), so outside the boundary guard.
import { runHome } from "../home/index";
import { runWorklog } from "../watch/index";
import { runTask } from "../task/index";
import { runCrew } from "../crew/index";

export const command = {
  // kobo-363: `team` is the canonical name; `dept` kept as an alias (same
  // routing — matchedName drives asDept below) during the vocab migration.
  name: ["company", "team", "dept"],
  description: "Logical company > team > oracle layer — registry, assign, tree.",
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

  // kobo-363: add-team is the canonical verb — add-dept kept as an alias
  // (same logic) during the departments→teams vocab migration.
  if (sub === "add-dept" || sub === "add-team") {
    const flags = parseFlags(args, { "--lead": String }, 1);
    const company = flags._[0];
    const dept = flags._[1];
    if (!company || !dept) {
      logs.push(`usage: maw company ${sub} <company> <team> [--lead <oracle>]`);
      return "company and team required";
    }
    addDepartment(company, dept, { lead: flags["--lead"] as string | undefined });
    logs.push(`${G}✓${R} team '${dept}' added to '${company}'${flags["--lead"] ? ` (lead: ${flags["--lead"]})` : ""}`);
    return;
  }

  // kobo-363: rm-team is the canonical verb — rm-dept kept as an alias.
  if (sub === "rm-dept" || sub === "rm-team") {
    const company = args[1];
    const dept = args[2];
    if (!company || !dept) {
      logs.push(`usage: maw company ${sub} <company> <team>`);
      return "company and team required";
    }
    removeDepartment(company, dept);
    logs.push(`${G}✓${R} team '${dept}' removed from '${company}'`);
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

  // Pull a policy snapshot from a manager repo's policies/ dir into
  // ~/.maw/companies/<co>/policy/ so the on-attach inject hook reads it locally.
  if (sub === "sync") {
    const flags = parseFlags(args, { "--from": String }, 1);
    const company = flags._[0];
    const from = flags["--from"] as string | undefined;
    if (!company || !from) {
      logs.push("usage: maw company sync <company> --from <manager-oracle|repo-path>");
      logs.push(`  ${D}pulls policies/{company.md,<dept>.md} → ~/.maw/companies/<company>/policy/${R}`);
      return "company and --from required";
    }
    const res = syncCompanyPolicy(company, from);
    if (!res.ok) { logs.push(`${Y}⚠${R} ${res.error}`); return res.error; }
    logs.push(`${G}✓${R} synced ${res.written.length} policy file(s) for '${company}' ${D}(from ${res.sourceDir})${R}`);
    for (const w of res.written) logs.push(`  ${G}●${R} ${w}`);
    if (res.missing.length) logs.push(`  ${D}missing in source: ${res.missing.join(", ")}${R}`);
    return;
  }

  // Sweep member CLAUDE.md files: strip the legacy static dept block (#19) so
  // dept identity is inject-on-attach only. Idempotent; commits CLAUDE.md
  // path-scoped, NEVER pushes (each oracle/Tony pushes).
  if (sub === "migrate") {
    const flags = parseFlags(args, { "--dry-run": Boolean, "--no-commit": Boolean }, 1);
    const company = flags._[0]; // optional — undefined sweeps every company
    const res = migrateCompanyPolicy(company, {
      dryRun: Boolean(flags["--dry-run"]),
      commit: !flags["--no-commit"],
    });
    const mode = flags["--dry-run"] ? ` ${D}(dry-run)${R}` : "";
    logs.push(`\n  ${C}migrate dept block → conditional inject${R}${mode}  ${D}swept: ${res.companies.join(", ") || "—"}${R}\n`);
    for (const o of res.outcomes) {
      if (o.stripped) logs.push(`  ${G}✓${R} ${o.oracle} ${D}— block stripped${o.committed ? " + committed" : ""}${R}`);
      else if (o.skippedReason === "no-block") logs.push(`  ${D}·${R} ${o.oracle} ${D}— no block (skip)${R}`);
      else logs.push(`  ${Y}⚠${R} ${o.oracle} ${D}— repo not resolved (skip)${R}`);
    }
    logs.push(`\n  ${D}${res.changed} stripped · push left to each oracle/Tony${R}\n`);
    return;
  }

  // Turn OFF policy inject for an oracle (pairs with `attach`). Defaults to the
  // current oracle ($CLAUDE_AGENT_NAME) when no name is given.
  if (sub === "detach") {
    const oracle = args[1] ?? process.env.CLAUDE_AGENT_NAME ?? "";
    if (!oracle) {
      logs.push("usage: maw company detach [<oracle>]  (defaults to $CLAUDE_AGENT_NAME)");
      return "oracle required";
    }
    const cleared = clearPolicyAttach(oracle);
    logs.push(cleared
      ? `${G}✓${R} detached '${oracle}' — policy inject off`
      : `${D}·${R} '${oracle}' was not attached`);
    return;
  }

  // Company-context hook provisioning (re-homed from `maw watch setup-hooks`):
  //   status  — who has / is missing the unified hook set
  //   repair  — install the set for every member missing it (sweep)
  //   prune   — strip the set from an oracle that left the company
  if (sub === "hooks") {
    return runHooks(args.slice(1), logs);
  }

  if (!sub || sub === "ls" || sub === "list") {
    renderList(logs);
    return;
  }

  logs.push(`unknown company subcommand: ${sub}`);
  logs.push("usage: maw company <create|add-team|add-dept|ls|tree|attach|detach|sync|migrate|hooks|home|worklog|task|crew|rm-team|rm-dept|delete>");
  return `unknown subcommand: ${sub}`;
}

/** True when `oracle` is still a member of ANY company (registry-fresh). */
function stillInAnyCompany(oracle: string): boolean {
  return listCompanies().some(c =>
    Object.values(c.teams).some(d => d.members.some(m => m.oracle === oracle)),
  );
}

// ─── company hooks verb: status | repair | prune ─────────────────────────────

function runHooks(args: string[], logs: string[]): string | undefined {
  const action = args[0]?.toLowerCase();

  if (action === "status") {
    const company = args[1];
    if (!company) { logs.push("usage: maw company hooks status <company>"); return "company required"; }
    const members = companyOracles(company);
    logs.push(`\n  ${C}${company}${R}  ${D}company-context hooks (${members.length} member${members.length === 1 ? "" : "s"})${R}\n`);
    if (members.length === 0) { logs.push(`  ${D}(no members)${R}\n`); return; }
    for (const oracle of members) {
      const st = hooksStatusForOracle(oracle);
      if (!st.hasDir) {
        logs.push(`  ${Y}∅${R} ${oracle.padEnd(24)} ${D}no checkout (deferred)${R}`);
      } else if (st.missing.length === 0) {
        logs.push(`  ${G}●${R} ${oracle.padEnd(24)} ${D}all ${st.installed.length} hooks${R}`);
      } else {
        logs.push(`  ${Y}◐${R} ${oracle.padEnd(24)} ${D}missing: ${st.missing.join(", ")}${R}`);
      }
    }
    logs.push("");
    return;
  }

  if (action === "repair") {
    const flags = parseFlags(args, { "--company": String }, 1);
    const company = flags._[0] ?? (flags["--company"] as string | undefined);
    if (!company) { logs.push("usage: maw company hooks repair <company> [--dry-run]"); return "company required"; }
    const dryRun = args.includes("--dry-run");
    const res = setupWorklogHooks({ company, dryRun });
    logs.push(`\n  ${C}${company}${R}  ${D}hooks repair${dryRun ? " (dry-run)" : ""}${R}\n`);
    logs.push(`  ${D}scripts: ${res.scriptsInstalled} ${dryRun ? "would install" : "installed/updated"}${R}`);
    if (res.updated.length) logs.push(`  ${G}${dryRun ? "would update" : "updated"}${R}: ${res.updated.join(", ")}`);
    if (res.alreadyOk.length) logs.push(`  ${D}ok (already): ${res.alreadyOk.join(", ")}${R}`);
    if (res.skipped.length) logs.push(`  ${Y}deferred (no checkout)${R}: ${res.skipped.join(", ")}`);
    logs.push("");
    return;
  }

  if (action === "prune") {
    const oracle = args[1];
    if (!oracle) { logs.push("usage: maw company hooks prune <oracle>"); return "oracle required"; }
    const outcome = pruneOracleHooks(oracle);
    logs.push(outcome === "pruned"
      ? `${G}✓${R} pruned company-context hooks from '${oracle}'`
      : `${D}·${R} '${oracle}' had no hooks to prune ${D}(${outcome})${R}`);
    return;
  }

  logs.push("usage: maw company hooks <status|repair|prune> ...");
  return `unknown hooks action: ${action ?? "(none)"}`;
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
    const depts = Object.entries(c.teams);
    logs.push(`  ${G}●${R} ${c.name}${R}  ${D}(${depts.length} team${depts.length === 1 ? "" : "s"})${R}`);
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
    const depts = Object.entries(c.teams);
    depts.forEach(([name, d], di) => {
      const last = di === depts.length - 1;
      const branch = last ? "└─" : "├─";
      const pad = last ? "   " : "│  ";
      logs.push(`  ${D}${branch}${R} ${name}`);
      d.members.forEach((m, mi) => {
        const mlast = mi === d.members.length - 1;
        const mbranch = mlast ? "└─" : "├─";
        const roleTag = m.role === "lead" ? `${Y}lead${R}` : `${D}${m.role}${R}`;
        logs.push(`  ${D}${pad}${mbranch}${R} ${m.oracle} ${D}·${R} ${roleTag}`);
      });
      if (d.members.length === 0) logs.push(`  ${D}${pad}└─ (no members)${R}`);
    });
    if (depts.length === 0) logs.push(`  ${D}└─ (no teams)${R}`);
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
    // Auto-provision the company-context hook set (worklog + policy) for this
    // oracle — best-effort, per-oracle (#2 spec). No checkout yet → defer to
    // the next `maw company attach`. Never fails the assignment.
    try {
      const outcome = provisionOracleHooks(oracle);
      if (outcome === "updated") logs.push(`  ${D}↳ hooks provisioned (worklog + policy)${R}`);
      else if (outcome === "skipped") logs.push(`  ${Y}↳ hooks deferred${R} ${D}— no checkout yet; attach to provision${R}`);
    } catch { /* best-effort — never block assign */ }
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
    // Prune the company-context hooks for an oracle that left — best-effort,
    // only when it no longer belongs to ANY company (avoid stripping hooks from
    // an oracle still assigned elsewhere). Never fails the removal.
    try {
      if (!stillInAnyCompany(oracle)) {
        const outcome = pruneOracleHooks(oracle);
        if (outcome === "pruned") logs.push(`  ${D}↳ hooks pruned${R}`);
      }
    } catch { /* best-effort */ }
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
    // Route by the matched surface: `maw team ...` / `maw dept ...` (kobo-363
    // alias) → dept verbs, else company.
    const asDept = ctx.matchedName === "team" || ctx.matchedName === "dept";
    // `attach` is an async company verb (shells out to maw attach / maw bud).
    const isAttach = !asDept && args[0]?.toLowerCase() === "attach";
    // cli-reorg: `maw company home|worklog|task <verb>` → the plugin's shared runner (async).
    const isHome = !asDept && args[0]?.toLowerCase() === "home";
    const isWorklog = !asDept && args[0]?.toLowerCase() === "worklog";
    const isTask = !asDept && args[0]?.toLowerCase() === "task";
    // kobo-358: `maw company crew spawn <co>` — deterministic idempotent crew-cell spawn.
    const isCrew = !asDept && args[0]?.toLowerCase() === "crew";
    // learn/knowledge/share/sync are async dept verbs (KB HTTP / soul-sync / hey).
    const isAsyncDept = asDept && ASYNC_DEPT_VERBS.has(args[0]?.toLowerCase() ?? "");
    const err = isAttach
      ? await runAttach(args, logs)
      : isHome
        ? (await runHome(args.slice(1), (l) => logs.push(l))).error
        : isWorklog
          ? (await runWorklog(args.slice(1), (l) => logs.push(l))).error
          : isTask
            ? (await runTask(args.slice(1), (l) => logs.push(l))).error
            : isCrew
              ? (await runCrew(args.slice(1), (l) => logs.push(l))).error
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
