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

import { parseFlags } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { companyOfOracleStrict } from "../../../core/worklog/company-scope";
import { commitHome, initHome } from "../../../core/home/store";

function resolveCompany(positional: string | undefined, flag: string | undefined): string | null {
  if (positional) return positional;
  if (flag) return flag;
  const cfg = loadConfig() as Record<string, unknown>;
  const oracle = (cfg.oracle as string) || "";
  // kobo-216 — strict: a multi-company oracle (no positional/flag above) THROWS instead
  // of silently first-matching; single-company + config fallback are unchanged.
  return (oracle && companyOfOracleStrict(oracle)) || (cfg.company as string) || null;
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

// cli-reorg kobo-26: the top-level `maw home` shim is REMOVED (Tony: hard-cut,
// no alias). This plugin is now a MODULE surface — `runHome` is imported by the
// company plugin (`maw company home`). No default handler / no cli command, so
// `maw home` → unknown command.
