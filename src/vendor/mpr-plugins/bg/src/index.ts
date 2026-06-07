/**
 * maw-bg plugin entry — dispatches `maw bg <subcommand>` to the right handler.
 *
 * Subcommand surface (locked in RFC#1):
 *   bg "<cmd>" [--name X]                       spawn detached tmux session
 *   bg ls [--json]                              list sessions
 *   bg tail <slug> [--lines N] [--follow]       sample buffer non-destructively
 *   bg attach <slug>                            re-attach (TTY)
 *   bg kill <slug> | --all                      reap session(s)
 *   bg gc [--dry-run] [--older-than DUR]        reap stale "done" sessions
 *
 * The host (`maw-js`) may call this module with either an InvokeContext
 * (`plugin/registry.ts`) or a raw argv array (legacy/new command registry
 * paths). The default export normalizes both to "everything after maw bg".
 */

import {
  bgSpawn, bgList, bgTail, bgTailFollow, bgAttach, bgKill, bgGc,
  type BgSession, type GcReport,
} from "./impl";
import { isUserError, UserError } from "./internal/user-error";
import { parseFlags } from "./internal/parse-flags";

export const manifest = {
  name: "bg",
  version: "0.1.0",
  description: "Run long commands in detached tmux and sample output without blocking the current pane.",
};

export interface InvokeResult {
  ok: boolean;
  output?: string;
  error?: string;
  /** Optional explicit exit code — UserError carries this through. */
  exitCode?: number;
}

type DualCtx = string[] | {
  source?: "cli" | "api" | "peer";
  args?: string[] | Record<string, unknown>;
};

function extractArgs(ctx: DualCtx): string[] {
  if (Array.isArray(ctx)) return ctx;
  if (ctx?.source === "cli" && Array.isArray(ctx.args)) return ctx.args;
  return [];
}

const HELP = `maw bg — run long commands in detached tmux without blocking the current pane

usage:
  maw bg "<cmd>" [--name X]              spawn detached tmux session
  maw bg ls [--json]                     list active maw-bg-* sessions
  maw bg tail <slug> [--lines N] [--follow]
                                         sample last N lines (default 200)
  maw bg attach <slug>                   attach (or switch-client inside tmux)
  maw bg kill <slug> | --all             reap session(s)
  maw bg gc [--dry-run] [--older-than DUR]
                                         reap stale "done" sessions (default 24h)

slug refs accept full slug, hash suffix (4 hex), or unique stem prefix.
`;

export default async function handler(ctx: DualCtx): Promise<InvokeResult> {
  const argv = extractArgs(ctx);
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      return { ok: true, output: HELP };
    }
    const sub = argv[0];
    const rest = argv.slice(1);

    switch (sub) {
      case "ls":
      case "list":
        return await runList(rest);
      case "tail":
        return await runTail(rest);
      case "attach":
        return await runAttach(rest);
      case "kill":
        return await runKill(rest);
      case "gc":
        return await runGc(rest);
      default:
        // No subcommand match — treat argv[0] as the cmd to spawn.
        return await runSpawn(argv);
    }
  } catch (e) {
    if (isUserError(e)) {
      return { ok: false, error: `Error: ${e.message}`, exitCode: e.exitCode };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Error: ${msg}` };
  }
}

async function runSpawn(argv: string[]): Promise<InvokeResult> {
  const flags = parseFlags(argv);
  if (flags.help) return { ok: true, output: HELP };
  const positionals = flags._;
  if (positionals.length === 0) {
    throw new UserError("bg: missing command (usage: maw bg \"<cmd>\")");
  }
  // Join all positionals so `maw bg npm test` and `maw bg "npm test"` both work.
  const cmd = positionals.join(" ");
  const res = bgSpawn(cmd, flags.name ? { name: flags.name } : {});
  return {
    ok: true,
    output: `${res.slug}\t${res.session}`,
  };
}

async function runList(argv: string[]): Promise<InvokeResult> {
  const flags = parseFlags(argv);
  const sessions = bgList();
  if (flags.json) {
    return { ok: true, output: JSON.stringify(sessions, null, 2) };
  }
  return { ok: true, output: formatList(sessions) };
}

function formatList(sessions: BgSession[]): string {
  if (sessions.length === 0) return "(no maw-bg sessions)";
  const rows = sessions.map((s) => [
    s.slug,
    s.status,
    formatAge(s.ageSeconds),
    s.lastLine.length > 60 ? s.lastLine.slice(0, 57) + "..." : s.lastLine,
  ]);
  const widths = [0, 0, 0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) => `${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`)
    .join("\n");
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

async function runTail(argv: string[]): Promise<InvokeResult> {
  const flags = parseFlags(argv);
  if (flags._.length === 0) throw new UserError("bg tail: missing <slug>");
  const slug = flags._[0];
  if (flags.follow) {
    await bgTailFollow(slug, { lines: flags.lines });
    return { ok: true };
  }
  const out = bgTail(slug, { lines: flags.lines });
  return { ok: true, output: out };
}

async function runAttach(argv: string[]): Promise<InvokeResult> {
  const flags = parseFlags(argv);
  if (flags._.length === 0) throw new UserError("bg attach: missing <slug>");
  const code = await bgAttach(flags._[0]);
  return { ok: code === 0, exitCode: code };
}

async function runKill(argv: string[]): Promise<InvokeResult> {
  const flags = parseFlags(argv);
  const slug = flags._[0];
  const killed = bgKill(slug, { all: flags.all });
  if (killed.length === 0) {
    return { ok: true, output: "(no sessions to kill)" };
  }
  return { ok: true, output: `killed: ${killed.join(", ")}` };
}

async function runGc(argv: string[]): Promise<InvokeResult> {
  const flags = parseFlags(argv);
  const report: GcReport = bgGc({
    dryRun: flags.dryRun,
    olderThan: flags.olderThan,
  });
  const verb = report.dryRun ? "would reap" : "reaped";
  const lines = [
    `${verb}: ${report.reaped.length === 0 ? "(none)" : report.reaped.join(", ")}`,
    `kept:    ${report.kept.length === 0 ? "(none)" : report.kept.join(", ")}`,
    `threshold: ${report.thresholdSeconds}s`,
  ];
  return { ok: true, output: lines.join("\n") };
}

// Re-export for SDK consumers / tests.
export {
  bgSpawn, bgList, bgTail, bgTailFollow, bgAttach, bgKill, bgGc,
} from "./impl";
export { UserError, isUserError } from "./internal/user-error";
export { parseFlags } from "./internal/parse-flags";
