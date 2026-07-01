/**
 * maw company worklog — activity worklog (debug/fallback view of the engine;
 * capture+inject runs via hooks). cli-reorg (ADR docs/company/0001): the worklog
 * is a per-company concern, so the canonical surface is `maw company worklog
 * <verb>`. The top-level `maw watch` remains for ONE release as a deprecation
 * shim that prints "moved" and forwards (Tony OQ1=b) — removed next release.
 *
 * Verbs (unchanged, OQ2 — no cull): log | inject | claim | release | sync |
 * setup-hooks. Thin CLI shell over src/core/worklog/*.
 */

import { parseFlags, type InvokeContext, type InvokeResult } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { readWorklog } from "../../../core/worklog/store";
import { renderTimeline } from "../../../core/worklog/render";
import { pollPrsOnce } from "../../../core/worklog/pr-watch";
import { setupWorklogHooks } from "../../../core/worklog/hook-setup";
import { companyOfOracle } from "../../../core/worklog/company-scope";
import { addClaim, releaseClaim } from "../../../core/worklog/claim";
import { pingCollision } from "../../../core/worklog/ping";
import { buildInjectSlice } from "../../../core/worklog/slice";

export const command = {
  name: "watch",
  description: "Activity worklog — debug/fallback view of the engine (capture+inject runs via hooks).",
};

function myOracle(): string {
  const cfg = loadConfig() as any;
  return cfg.oracle || process.env.CLAUDE_AGENT_NAME || "unknown";
}

/**
 * Shared worklog CLI runner — the single source of truth for the worklog verbs.
 * Both `maw company worklog` (company plugin) and the top-level `maw watch` shim
 * call this, so the two surfaces can never diverge. `emit` receives user-facing
 * lines; returns an ok/error result (no printing of its own).
 */
export async function runWorklog(
  args: string[],
  emit: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const subcmd = args[0];

  if (subcmd === "log") {
    const flags = parseFlags(args.slice(1), { "--limit": String, "--oracle": String, "--company": String }, 0);
    if (!args.includes("--no-poll")) { try { await pollPrsOnce(); } catch { /* render anyway */ } }
    const company = flags["--company"] ?? companyOfOracle(myOracle()) ?? (loadConfig() as any).company;
    const limit = flags["--limit"] ? Math.max(1, parseInt(flags["--limit"], 10) || 50) : 50;
    emit(renderTimeline(readWorklog(company, { limit, oracle: flags["--oracle"] })));
    return { ok: true };
  }

  if (subcmd === "inject") {
    // offline preview of the exact slice the hooks inject (no server needed)
    const flags = parseFlags(args.slice(1), { "--oracle": String }, 0);
    const oracle = flags["--oracle"] ?? myOracle();
    const slice = buildInjectSlice(oracle);
    emit(slice || `(nothing to inject for ${oracle} — no open claims or recent activity)`);
    return { ok: true };
  }

  if (subcmd === "claim") {
    const task = args.slice(1).filter(a => !a.startsWith("--")).join(" ").trim();
    if (!task) return { ok: false, error: 'usage: maw company worklog claim "<task>"' };
    const { collisions } = addClaim(myOracle(), task);
    emit(`\x1b[36m⛏ claimed:\x1b[0m ${task}`);
    if (collisions.length) {
      const others = collisions.map(c => c.oracle);
      emit(`\x1b[33m⚠ overlap with open claim(s):\x1b[0m ${others.map((o, i) => `${o} ("${collisions[i].task ?? collisions[i].summary}")`).join(", ")}`);
      pingCollision(myOracle(), task, others);
    }
    return { ok: true };
  }

  if (subcmd === "release") {
    const task = args.slice(1).filter(a => !a.startsWith("--")).join(" ").trim();
    if (!task) return { ok: false, error: 'usage: maw company worklog release "<task>"' };
    releaseClaim(myOracle(), task);
    emit(`\x1b[32m✔ released:\x1b[0m ${task}`);
    return { ok: true };
  }

  if (subcmd === "sync") {
    const recorded = await pollPrsOnce();
    emit(`\x1b[32m✓\x1b[0m synced — ${recorded.length} new event${recorded.length === 1 ? "" : "s"}`);
    return { ok: true };
  }

  if (subcmd === "setup-hooks") {
    const dryRun = args.includes("--dry-run");
    const flags = parseFlags(args.slice(1), { "--company": String }, 0);
    const res = setupWorklogHooks({ dryRun, company: flags["--company"] });
    emit(`\n\x1b[90m(also available as \x1b[0mmaw company hooks repair <company>\x1b[90m)\x1b[0m`);
    emit(`\n\x1b[36mWorklog hook setup\x1b[0m${dryRun ? " \x1b[90m(dry run)\x1b[0m" : ""}\n`);
    emit(`  scripts: ${res.scriptsInstalled} ${dryRun ? "would install" : "installed/updated"}`);
    if (res.updated.length) emit(`  \x1b[32m${dryRun ? "would update" : "updated"}\x1b[0m: ${res.updated.join(", ")}`);
    if (res.alreadyOk.length) emit(`  \x1b[90mok (already)\x1b[0m: ${res.alreadyOk.join(", ")}`);
    if (res.skipped.length) emit(`  \x1b[33mskip (no dir)\x1b[0m: ${res.skipped.join(", ")}`);
    if (!res.updated.length && !res.alreadyOk.length) emit(`  \x1b[33mno target oracles\x1b[0m (check company config)`);
    emit("");
    return { ok: true };
  }

  return { ok: false, error: 'usage: maw company worklog <log|inject|claim|release|sync|setup-hooks> [opts]' };
}

// Top-level `maw watch` — DEPRECATION SHIM (ADR docs/company/0001, OQ1=b). Prints
// "moved" then forwards to the shared runner. Removed next release; new callers
// use `maw company worklog`.
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const emit = (line: string) => { if (ctx.writer) ctx.writer(line); else logs.push(line); };
  emit(`\x1b[33m⚠ 'maw watch' moved → 'maw company worklog'\x1b[0m \x1b[90m(this alias will be removed next release)\x1b[0m`);

  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const r = await runWorklog(args, emit);
  const output = logs.join("\n") || undefined;
  // Transparent forward: surface runWorklog's clean error (usage) — the notice
  // lives in `output` and must NOT shadow it (the shim forwards ALL input).
  if (!r.ok) return { ok: false, error: r.error, output };
  return { ok: true, output };
}
