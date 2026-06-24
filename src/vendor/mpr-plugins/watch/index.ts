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

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => { if (ctx.writer) ctx.writer(...a); else logs.push(a.map(String).join(" ")); };
  console.error = (...a: any[]) => { if (ctx.writer) ctx.writer(...a); else logs.push(a.map(String).join(" ")); };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const subcmd = args[0];

    if (subcmd === "log") {
      const flags = parseFlags(args.slice(1), { "--limit": String, "--oracle": String, "--company": String }, 0);
      if (!args.includes("--no-poll")) { try { await pollPrsOnce(); } catch { /* render anyway */ } }
      const company = flags["--company"] ?? companyOfOracle(myOracle()) ?? (loadConfig() as any).company;
      const limit = flags["--limit"] ? Math.max(1, parseInt(flags["--limit"], 10) || 50) : 50;
      console.log(renderTimeline(readWorklog(company, { limit, oracle: flags["--oracle"] })));
    } else if (subcmd === "inject") {
      // offline preview of the exact slice the hooks inject (no server needed)
      const flags = parseFlags(args.slice(1), { "--oracle": String }, 0);
      const oracle = flags["--oracle"] ?? myOracle();
      const slice = buildInjectSlice(oracle);
      console.log(slice || `(nothing to inject for ${oracle} — no open claims or recent activity)`);
    } else if (subcmd === "claim") {
      const task = args.slice(1).filter(a => !a.startsWith("--")).join(" ").trim();
      if (!task) return { ok: false, error: 'usage: maw watch claim "<task>"' };
      const { collisions } = addClaim(myOracle(), task);
      console.log(`\x1b[36m⛏ claimed:\x1b[0m ${task}`);
      if (collisions.length) {
        const others = collisions.map(c => c.oracle);
        console.log(`\x1b[33m⚠ overlap with open claim(s):\x1b[0m ${others.map((o, i) => `${o} ("${collisions[i].task ?? collisions[i].summary}")`).join(", ")}`);
        pingCollision(myOracle(), task, others);
      }
    } else if (subcmd === "release") {
      const task = args.slice(1).filter(a => !a.startsWith("--")).join(" ").trim();
      if (!task) return { ok: false, error: 'usage: maw watch release "<task>"' };
      releaseClaim(myOracle(), task);
      console.log(`\x1b[32m✔ released:\x1b[0m ${task}`);
    } else if (subcmd === "sync") {
      const recorded = await pollPrsOnce();
      console.log(`\x1b[32m✓\x1b[0m synced — ${recorded.length} new event${recorded.length === 1 ? "" : "s"}`);
    } else if (subcmd === "setup-hooks") {
      const dryRun = args.includes("--dry-run");
      const flags = parseFlags(args.slice(1), { "--company": String }, 0);
      const res = setupWorklogHooks({ dryRun, company: flags["--company"] });
      console.log(`\n\x1b[90m(re-homed → \x1b[0mmaw company hooks repair <company>\x1b[90m — this still works as an escape-hatch)\x1b[0m`);
      console.log(`\n\x1b[36mWorklog hook setup\x1b[0m${dryRun ? " \x1b[90m(dry run)\x1b[0m" : ""}\n`);
      console.log(`  scripts: ${res.scriptsInstalled} ${dryRun ? "would install" : "installed/updated"}`);
      if (res.updated.length) console.log(`  \x1b[32m${dryRun ? "would update" : "updated"}\x1b[0m: ${res.updated.join(", ")}`);
      if (res.alreadyOk.length) console.log(`  \x1b[90mok (already)\x1b[0m: ${res.alreadyOk.join(", ")}`);
      if (res.skipped.length) console.log(`  \x1b[33mskip (no dir)\x1b[0m: ${res.skipped.join(", ")}`);
      if (!res.updated.length && !res.alreadyOk.length) console.log(`  \x1b[33mno target oracles\x1b[0m (check company config)`);
      console.log();
    } else {
      return { ok: false, error: 'usage: maw watch <log|inject|claim|release|sync|setup-hooks> [opts]' };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
