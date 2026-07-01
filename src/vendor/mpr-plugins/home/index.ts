/**
 * maw home — Company Home as a git repo (ADR 0002).
 *
 *   maw company home init   [<company>] [--org o] [--repo org/name] [--branch b]
 *   maw company home commit [<company>] [-m "<msg>"] [--branch b] [--no-push]
 *
 * Home is a per-company concern (ADR docs/company/0001 cli-reorg), so the real
 * surface is `maw company home <verb>`. The top-level `maw home` remains for ONE
 * release as a deprecation shim that prints "moved" and forwards (Tony's call,
 * OQ1=b) — removed next release.
 *
 * Thin CLI shell over src/core/home/* (mirrors the `task` plugin). The verbs are
 * the ONLY place git touches the home — never the engine hot-path (ADR 0002 Q3).
 * Company is a positional, or resolved from config like `maw task`.
 */

import { parseFlags, type InvokeContext, type InvokeResult } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { companyOfOracle } from "../../../core/worklog/company-scope";
import { commitHome, initHome } from "../../../core/home/store";

export const command = {
  name: "home",
  description: "Company Home git repo — init a private remote, commit/push snapshots (ADR 0002).",
};

function resolveCompany(positional: string | undefined, flag: string | undefined): string | null {
  if (positional) return positional;
  if (flag) return flag;
  const cfg = loadConfig() as Record<string, unknown>;
  const oracle = (cfg.oracle as string) || "";
  return (oracle && companyOfOracle(oracle)) || (cfg.company as string) || null;
}

/**
 * Shared home CLI runner — the single source of truth for `home <init|commit>`.
 * Both the top-level shim (`maw home`) and `maw company home` (via the company
 * plugin) call this, so the two surfaces can never diverge. `emit` receives
 * user-facing lines; returns an ok/error result (no printing of its own).
 */
export async function runHome(
  args: string[],
  emit: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const subcmd = args[0];

  if (subcmd === "init") {
    const flags = parseFlags(args.slice(1), { "--org": String, "--repo": String, "--branch": String, "--company": String }, 0);
    const company = resolveCompany(flags._[0], flags["--company"]);
    if (!company) return { ok: false, error: "no company — pass it: maw company home init <company>" };
    const r = initHome({ company, org: flags["--org"], repo: flags["--repo"], branch: flags["--branch"] });
    for (const s of r.steps) emit(`  \x1b[90m·\x1b[0m ${s}`);
    if (!r.ok) return { ok: false, error: r.error };
    emit(`\x1b[32m✓ home ready\x1b[0m ${company} \x1b[90m(${r.dir})\x1b[0m`);
    return { ok: true };
  }

  if (subcmd === "commit") {
    const noPush = args.includes("--no-push");
    const flags = parseFlags(args.slice(1), { "-m": String, "--message": String, "--branch": String, "--company": String }, 0);
    const company = resolveCompany(flags._[0], flags["--company"]);
    if (!company) return { ok: false, error: "no company — pass it: maw company home commit <company>" };
    const r = commitHome({ company, message: flags["-m"] ?? flags["--message"], branch: flags["--branch"], push: !noPush });
    for (const s of r.steps) emit(`  \x1b[90m·\x1b[0m ${s}`);
    if (!r.ok) return { ok: false, error: r.error };
    emit(`\x1b[32m✓ committed\x1b[0m ${company}`);
    return { ok: true };
  }

  return { ok: false, error: "usage: maw company home <init|commit> [<company>] — init [--org o --repo org/name --branch b] · commit [-m msg --no-push]" };
}

// Top-level `maw home` — DEPRECATION SHIM (ADR docs/company/0001, OQ1=b). Prints
// "moved" then forwards to the shared runner. Removed next release; new callers
// use `maw company home`.
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const emit = (line: string) => { if (ctx.writer) ctx.writer(line); else logs.push(line); };
  emit(`\x1b[33m⚠ 'maw home' moved → 'maw company home'\x1b[0m \x1b[90m(this alias will be removed next release)\x1b[0m`);

  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const r = await runHome(args, emit);
  const output = logs.join("\n") || undefined;
  // Transparent forward: surface runHome's clean error (usage / not-found) — the
  // notice lives in `output` and must NOT shadow it (the shim forwards ALL input).
  if (!r.ok) return { ok: false, error: r.error, output };
  return { ok: true, output };
}
