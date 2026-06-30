/**
 * maw home — Company Home as a git repo (ADR 0002).
 *
 *   maw home init   [<company>] [--org o] [--repo org/name] [--branch b]
 *   maw home commit [<company>] [-m "<msg>"] [--branch b] [--no-push]
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

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { if (ctx.writer) ctx.writer(...a); else logs.push(a.map(String).join(" ")); };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const subcmd = args[0];

    if (subcmd === "init") {
      const flags = parseFlags(args.slice(1), { "--org": String, "--repo": String, "--branch": String, "--company": String }, 0);
      const company = resolveCompany(flags._[0], flags["--company"]);
      if (!company) return { ok: false, error: "no company — pass it: maw home init <company>" };
      const r = initHome({ company, org: flags["--org"], repo: flags["--repo"], branch: flags["--branch"] });
      for (const s of r.steps) console.log(`  \x1b[90m·\x1b[0m ${s}`);
      if (!r.ok) return { ok: false, error: r.error };
      console.log(`\x1b[32m✓ home ready\x1b[0m ${company} \x1b[90m(${r.dir})\x1b[0m`);
    } else if (subcmd === "commit") {
      const noPush = args.includes("--no-push");
      const flags = parseFlags(args.slice(1), { "-m": String, "--message": String, "--branch": String, "--company": String }, 0);
      const company = resolveCompany(flags._[0], flags["--company"]);
      if (!company) return { ok: false, error: "no company — pass it: maw home commit <company>" };
      const r = commitHome({ company, message: flags["-m"] ?? flags["--message"], branch: flags["--branch"], push: !noPush });
      for (const s of r.steps) console.log(`  \x1b[90m·\x1b[0m ${s}`);
      if (!r.ok) return { ok: false, error: r.error };
      console.log(`\x1b[32m✓ committed\x1b[0m ${company}`);
    } else {
      return { ok: false, error: "usage: maw home <init|commit> [<company>] — init [--org o --repo org/name --branch b] · commit [-m msg --no-push]" };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
