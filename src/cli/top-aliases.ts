/**
 * Top-level verb aliases — RFC #954 (Axis 2: help-prominence / verb routing).
 *
 * Single source of truth for short verbs that route directly without going
 * through the plugin dispatcher. Inserted between `routeTools` and
 * `matchCommand` in src/cli.ts.
 *
 * Two forms:
 *   1. Argv-rewrite — splice `args` in place, continue normal dispatch
 *      Example: `maw a foo` → `maw tmux attach foo` (handled by tmux plugin)
 *   2. Direct-handler — static-imported function reference
 *      Example: `maw wake foo` → cmdWake(foo, opts) directly
 *
 * One-shot only — aliases NEVER expand into another alias. If the rewrite
 * target itself names another alias, that's a bug in the table, not a feature.
 *
 * IMPORTANT: handlers are STATIC imports, not dynamic. When this file is
 * bundled into src/cli.ts via bun build, dynamic `import("../commands/...")`
 * paths get resolved relative to the bundled cli.ts (one dir up from where
 * the source lives), which breaks at runtime. Static imports are inlined by
 * the bundler, sidestepping the resolution context mismatch entirely.
 */

import { cmdWake } from "../commands/shared/wake-cmd";
import { activeDurationArg, cmdTmuxLayout, cmdTmuxLs, parseActiveDurationSeconds } from "../commands/plugins/tmux/impl";
import { cmdPreflight } from "../commands/shared/preflight";
import { cmdNew } from "./cmd-new";
import { parseFlags } from "./parse-args";
import { UserError } from "../core/util/user-error";
import { parseBringToTarget } from "../commands/shared/bring-flags";
import { lsFederated } from "../vendor/mpr-plugins/ls/internal/peer-call";

export type DirectHandler = { kind: "direct"; handler: string };
export type AliasResolution =
  | { kind: "argv"; argv: string[] }
  | { kind: "direct"; handler: string; argv: string[] };

export const ALIAS_DESCRIPTIONS: Record<string, string> = {
  a: "Attach to a tmux session; use --shell for a repo shell pane",
  kill: "Kill a tmux pane or session",
  split: "Split pane and attach to a session",
  open: "Bring back hidden panes (join-pane)",
  close: "Hide panes without killing (break-pane)",
  t: "Team — create, spawn, send, shutdown",
  layout: "Apply tmux layout to the current window",
  zoom: "Toggle zoom on a pane",
  panes: "List all panes across sessions",
  cleanup: "Kill zombie agent panes",
  tile: "Tile current window or spawn N panes tiled",
  bring: "Bring an oracle HERE — thin alias for `wake --split`",
  b: "Bring an oracle HERE (short form of `bring`)",
  ls: "List local sessions by default; use --federation for peers",
  scaffold: "Create oracle repo + skeleton only (no commit, wake, or /awaken)",
  wake: "Wake an oracle session (fuzzy match, auto-clone)",
  awake: "Launch an oracle process with optional engine (does not trigger /awaken)",
  new: "Create a plain tmux workspace session",
  preflight: "Pre-flight check — version, plugins, dead agents, config",
  snapshots: "List and inspect fleet recovery snapshots",
};

export const TOP_ALIASES: Record<string, string[] | DirectHandler> = {
  // Argv-rewrite form — canonical handler lives in a core plugin
  a: ["attach"],
  kill: ["tmux", "kill"],
  split: ["split"],
  open: ["tmux", "open"],
  close: ["tmux", "close"],
  t: ["team"],
  layout: { kind: "direct", handler: "cmdLayout" },
  zoom: ["tmux", "zoom"],
  panes: ["tmux", "ls", "--all", "--verbose"],
  cleanup: ["team", "cleanup", "--zombie-agents"],
  tile: ["tile"],
  bring: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdBring" },
  b: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdBring" },

  // Direct-handler form — `ls` flags differ from tmux ls:
  //   maw ls          → compact local live-session summary (#1613 legacy path)
  //   maw ls --federation → explicit local+peer view (#1870)
  //   maw ls -v       → full per-pane detail
  //   maw ls -a       → compact + sleeping oracles (roster; legacy behavior)
  //   maw ls --active [30m|1h] → local sessions touched within the threshold
  ls: { kind: "direct", handler: "cmdLs" },
  scaffold: ["bud", "--scaffold-only"],

  // Direct-handler form — cmdWake is in core (src/commands/shared/wake-cmd.ts)
  // even though the wake/ plugin was extracted to the registry in #918.
  wake: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdWake" },
  awake: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdAwake" },
  new: { kind: "direct", handler: "./cmd-new:cmdNew" },

  preflight: { kind: "direct", handler: "../commands/shared/preflight:cmdPreflight" },
  snapshots: ["fleet", "snapshots"],
};

/**
 * Resolve a top-level alias from raw argv.
 *
 * @returns
 *   - `{ kind: "argv", argv }` for argv-rewrite (caller splices into args)
 *   - `{ kind: "direct", handler, argv }` for direct-handler dispatch
 *   - `null` when args[0] is not a registered alias
 */
export function resolveTopAlias(args: string[]): AliasResolution | null {
  if (args.length === 0) return null;
  const verb = args[0]?.toLowerCase();
  if (!verb) return null;
  const entry = TOP_ALIASES[verb];
  if (!entry) return null;

  // Argv-rewrite: replace args[0] with the canonical chain, keep rest.
  if (Array.isArray(entry)) return { kind: "argv", argv: [...entry, ...args.slice(1)] };

  // Direct-handler: pass the rest of argv (everything after the verb) as-is.
  return { kind: "direct", handler: entry.handler, argv: args.slice(1) };
}

export function parseBringArgs(
  argv: string[],
  writeUsage: (line: string) => void = console.error,
): {
  oracle: string;
  opts: { bring?: true; split?: boolean; tab?: boolean; engine?: string; pick?: boolean; session?: string; splitTarget?: string };
} {
  // #1799: `maw bring <oracle>` is a thin `maw wake <oracle> --split`
  // alias. Keep this tiny parser for legacy unit tests and usage validation;
  // runtime dispatch goes through the wake parser so all wake flags work.
  const flags = parseFlags(argv, {
    "--engine": String, "-e": "--engine",
    "--split": Boolean,
    "--tab": Boolean,
    "--to": String,
    "--pick": Boolean,
  }, 0);
  const oracle = (flags._ as string[])[0];
  if (!oracle) {
    printBringUsage(writeUsage);
    throw new UserError("bring: missing oracle name");
  }
  const opts: { bring?: true; split?: boolean; tab?: boolean; engine?: string; pick?: boolean; session?: string; splitTarget?: string } = { split: true };
  if (flags["--engine"]) opts.engine = flags["--engine"];
  if (flags["--pick"]) opts.pick = true;
  if (flags["--to"]) {
    const target = parseBringToTarget(flags["--to"]);
    opts.session = target.session;
    if (target.window) opts.splitTarget = `${target.session}:${target.window}`;
  }
  return { oracle, opts };
}

function printLayoutUsage(write: (line: string) => void = console.log): void {
  write("usage: maw layout <preset>");
  write("  Re-apply a tmux layout preset to the current window.");
  write("  presets: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled");
  write("  For explicit targets, use: maw tmux layout <target> <preset>");
}

function printBringUsage(write: (line: string) => void = console.log): void {
  write("usage: maw bring <oracle> [--to <session[:window]>] [wake flags...]");
  write("       maw b <oracle> [--to <session[:window]>] [wake flags...]");
  write("  Thin alias: maw bring <oracle> ≡ maw wake <oracle> --split");
  write("  Supports the same flags as `maw wake`, including --task, --wt, --dry-run, and -e/--engine.");
  write("  --to <session[:window]> targets a workspace session, optionally splitting inside a specific tab (#1816).");
  write("  --pick prompts when a fuzzy live window match needs an explicit bring target (#1816).");
  write("  Refuses to split-bring an oracle into its own pane (set MAW_ALLOW_SELF_BRING=1 to override).");
}

function printWakeAliasUsage(verb: "wake" | "awake", write: (line: string) => void = console.log): void {
  write(`usage: maw ${verb} <oracle> [--session <tmux-session>] [--task <s>] [--wt <s>] [--layout nested|legacy] [--bud] [--signal-on-birth] [-p|--prompt <s>] [--incubate <slug>] [--fresh|--new] [--pick] [--name <s>] [-a|--attach] [--list] [--dry-run] [--from-snapshot|--snapshot <id>] [--main|--solo|--no-rehydrate] [--split] [--all-local] [-e|--engine <name>]`);
  if (verb === "awake") {
    write("  Launch/start an oracle process with the selected engine. Does not send /awaken.");
    write("  Use `maw awaken` for the awakening ritual; use `maw new` for a plain workspace session.");
  } else {
    write("  Wake or reuse an oracle session, fuzzy-resolving repos and worktrees as needed.");
  }
  write("  --session targets an existing foreign workspace session instead of the oracle's own session.");
  write("  --fresh/--new forces a new numbered worktree slot; default prefers a stable reusable slot.");
  write("  --layout selects new worktree filesystem layout: nested (default repo/agents/N-X) or legacy (.wt-N-X).");
  write("  --pick opens the reusable worktree picker; --name creates/reuses a stable named worktree.");
  write("  --list previews worktrees only; it does not create sessions or respawn windows.");
  write("  --from-snapshot restores missing windows from the latest recovery snapshot; --snapshot <id> selects one.");
  write("  --bud with --task/--wt writes ψ/.lineage.yaml in the worktree (no repo/fleet mutation).");
  write("  --signal-on-birth with --bud also drops a parent ψ/memory/signals birth signal.");
}

/**
 * Invoke a direct-handler alias. Used by `wake` and `ls`.
 *
 * Handler spec format kept as "<path>:<exportName>" for documentation +
 * help-text rendering, but the path is no longer used at runtime —
 * dispatch is by `exportName` against a static handler map.
 *
 * For `ls`, compact summary is the default; `-v` returns full per-pane detail,
 * `-c` is an explicit compact alias, `-a` preserves the legacy
 * compact+roster behavior, `-r/--recent [N]` sorts newest-first, and
 * `--active [duration]` filters by tmux session_activity (default 30m).
 * For `wake`, parses the 9 known flags and calls cmdWake(oracle, opts).
 */

function missingLongArgName(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if ((error as { code?: string }).code !== "ARG_MISSING_REQUIRED_LONGARG") return null;
  const match = /option requires argument: (\S+)/.exec(error.message);
  return match?.[1] ?? "option";
}

export function parseLsAliasOpts(argv: string[]) {
  const flags = parseFlags(argv, {
    "--all": Boolean, "-a": "--all",
    "--compact": Boolean, "-c": "--compact",
    "--verbose": Boolean, "-v": "--verbose",
    "--fix": Boolean,
    "--federation": Boolean,
    "--json": Boolean,
    "--recent": Boolean, "-r": "--recent",
    "--active": Boolean,
    "--node": String,
    "--channels": Boolean,
    "--verify": Boolean,
  }, 0);

  // #1613 — restore the original compact default. `-v/--verbose` opts into
  // per-pane detail; `-c/--compact` is an explicit alias for the default.
  // `-a/--all` historically meant "include sleeping roster" on top-level
  // `maw ls`; keep that legacy shape by rendering the compact roster view.
  const verbose = !!flags["--verbose"] && !flags["--compact"] && !flags["--all"];
  const compact = !verbose || !!flags["--compact"] || !!flags["--all"];
  const opts: {
    all: true;
    compact: boolean;
    verbose: boolean;
    roster: boolean;
    json: boolean;
    recent?: boolean;
    recentLimit?: number;
    active?: boolean;
    activeThresholdSec?: number;
    filter?: string;
    channels?: boolean;
    oracleOnly?: boolean;
    verify?: boolean;
    federation?: boolean;
  } = {
    all: true,
    compact,
    verbose,
    roster: !!flags["--all"],
    json: !!flags["--json"],
  };
  if (flags["--channels"] || flags["--all"]) opts.channels = true;
  if (compact && !flags["--all"] && !flags["--channels"]) opts.oracleOnly = true;
  if (flags["--verify"]) opts.verify = true;
  if (flags["--federation"]) opts.federation = true;
  const positionals = flags._ as string[];
  const activeArg = activeDurationArg(argv);
  const filterPositionals = activeArg
    ? positionals.filter((arg) => arg !== activeArg)
    : positionals;
  const nodeFilter = typeof flags["--node"] === "string" ? flags["--node"].trim() : "";
  const positionalFilter = filterPositionals.find((arg) => !/^\d+$/.test(arg) && !(flags["--active"] && parseActiveDurationSeconds(arg)))?.trim() ?? "";
  if (nodeFilter || positionalFilter) opts.filter = nodeFilter || positionalFilter;

  if (flags["--recent"]) {
    opts.recent = true;
    const limitRaw = positionals.find((arg) => /^\d+$/.test(arg));
    if (limitRaw) {
      const limit = Number(limitRaw);
      if (Number.isSafeInteger(limit) && limit > 0) opts.recentLimit = limit;
    }
  }
  if (flags["--active"]) {
    opts.active = true;
    opts.activeThresholdSec = parseActiveDurationSeconds(activeArg) ?? undefined;
  }
  return opts;
}

function printLsAliasUsage(write: (line: string) => void): void {
  write("usage: maw ls [filter] [--all|-a] [--verbose|-v] [--compact|-c] [--json] [--recent|-r [N]] [--active [30m|1h]]");
  write("       maw ls --federation [--node <node>] [--json]");
  write("       maw ls --channels | --verify | --fix");
  write("");
  write("List live local sessions by default. Use --federation for local + peer inventory.");
  write("");
  write("Options:");
  write("  --federation       query configured peers in parallel (2s timeout each)");
  write("  -v, --verbose      show full per-pane detail");
  write("  -a, --all          include sleeping roster and channel sessions");
  write("  --channels         include channel/infrastructure sessions");
  write("  -r, --recent [N]   sort newest-first, optionally limiting to N sessions");
  write("  --active [DUR]     show sessions touched within a duration (default from tmux helper)");
  write("  --node <node>      filter sessions by node/name");
  write("  --verify           include worktree-bind diagnostics");
  write("  --fix              prune orphaned worktrees");
}

type MaybePromise<T = unknown> = T | Promise<T>;

export interface TopAliasHandlerDeps {
  cmdTmuxLs?: (opts: ReturnType<typeof parseLsAliasOpts>) => MaybePromise;
  lsFederated?: (opts: Parameters<typeof lsFederated>[0]) => MaybePromise<{ ok: boolean; output?: string; error?: string }>;
  cmdTmuxLayout?: (target: string, preset: string) => MaybePromise;
  cmdWake?: (oracle: string, opts: Record<string, unknown>) => MaybePromise;
  cmdNew?: (argv: string[]) => MaybePromise;
  cmdPreflight?: (opts: { fix: boolean }) => MaybePromise;
  loadConfig?: () => { commands?: Record<string, unknown> };
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export async function invokeDirectHandler(
  handler: string,
  argv: string[],
  deps: TopAliasHandlerDeps = {},
): Promise<void> {
  const exportName = handler.includes(":") ? handler.split(":")[1] : handler;
  if (!exportName) {
    throw new Error(`top-alias: malformed handler spec '${handler}' — expected '<module>:<export>' or name`);
  }

  const directCmdTmuxLs = deps.cmdTmuxLs ?? cmdTmuxLs;
  const directLsFederated = deps.lsFederated ?? lsFederated;
  const directCmdTmuxLayout = deps.cmdTmuxLayout ?? cmdTmuxLayout;
  const directCmdWake = deps.cmdWake ?? cmdWake;
  const directCmdNew = deps.cmdNew ?? cmdNew;
  const directCmdPreflight = deps.cmdPreflight ?? cmdPreflight;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  if (exportName === "cmdLs") {
    if (argv.some(a => a === "-h" || a === "--help" || a === "-help")) {
      printLsAliasUsage(log);
      return;
    }
    try {
      const opts = parseLsAliasOpts(argv);
      if (!opts.federation) {
        await directCmdTmuxLs(opts);
        return;
      }
      const result = await directLsFederated({
        json: opts.json,
        node: opts.filter,
        active: opts.active,
        activeThresholdSec: opts.activeThresholdSec,
      });
      if (result.output) log(result.output);
      if (!result.ok) {
        if (result.error) error(result.error);
        throw new UserError(result.error ?? "ls failed");
      }
    } catch (e) {
      const missingArg = missingLongArgName(e);
      if (!missingArg) throw e;
      printLsAliasUsage(error);
      error(`✗ maw ls: ${missingArg} requires a value`);
      throw new UserError(`ls: missing value for ${missingArg}`);
    }
    return;
  }

  if (exportName === "cmdLayout") {
    if (argv.some(a => a === "-h" || a === "--help" || a === "-help")) {
      printLayoutUsage(log);
      return;
    }
    const flags = parseFlags(argv, {}, 0);
    const preset = (flags._ as string[])[0];
    if (!preset) {
      printLayoutUsage(error);
      throw new UserError("layout: missing preset");
    }
    await directCmdTmuxLayout(".", preset);
    return;
  }

  if (exportName === "cmdWake" || exportName === "cmdAwake") {
    const verb = exportName === "cmdAwake" ? "awake" : "wake";
    if (argv.some(a => a === "-h" || a === "--help" || a === "-help")) {
      printWakeAliasUsage(verb, log);
      return;
    }

    const flags = parseFlags(argv, {
      "--task": String,
      "--wt": String,
      "--layout": String,
      "--session": String,
      "--prompt": String, "-p": "--prompt",
      "--incubate": String,
      "--fresh": Boolean, "--new": "--fresh",
      "--pick": Boolean,
      "--name": String,
      "--bud": Boolean,
      "--signal-on-birth": Boolean,
      "--attach": Boolean, "-a": "--attach",
      "--list": Boolean,
      "--dry-run": Boolean,
      "--from-snapshot": Boolean,
      "--snapshot": String,
      "--main": Boolean, "--solo": "--main", "--no-rehydrate": "--main",
      "--split": Boolean,
      "--split-target": String,
      "--bring-alias": Boolean,
      "--all-local": Boolean,
      "--engine": String, "-e": "--engine",
    }, 0);

    const positional = flags._;
    const oracle = positional[0];
    if (!oracle) {
      printWakeAliasUsage(verb, error);
      throw new UserError(`${verb}: missing oracle name`);
    }

    const opts: {
      task?: string;
      wt?: string;
      session?: string;
      prompt?: string;
      incubate?: string;
      fresh?: boolean;
      pick?: boolean;
      name?: string;
      attach?: boolean;
      listWt?: boolean;
      dryRun?: boolean;
      noRehydrate?: boolean;
      split?: boolean;
      splitTarget?: string;
      bringAlias?: boolean;
      bud?: boolean;
      signalOnBirth?: boolean;
      allLocal?: boolean;
      engine?: string;
      fromSnapshot?: boolean;
      snapshotId?: string;
      layout?: "nested" | "legacy";
    } = {};
    if (flags["--task"]) opts.task = flags["--task"];
    if (flags["--wt"]) opts.wt = flags["--wt"];
    if (flags["--layout"]) {
      const layout = flags["--layout"];
      if (layout !== "nested" && layout !== "legacy") throw new UserError("wake: --layout must be nested or legacy");
      opts.layout = layout;
    }
    if (flags["--session"]) opts.session = flags["--session"];
    if (flags["--prompt"]) opts.prompt = flags["--prompt"];
    if (flags["--incubate"]) opts.incubate = flags["--incubate"];
    if (flags["--fresh"]) opts.fresh = true;
    if (flags["--pick"]) opts.pick = true;
    if (flags["--name"]) opts.name = flags["--name"];
    if (flags["--bud"]) opts.bud = true;
    if (flags["--signal-on-birth"]) opts.signalOnBirth = true;
    if (flags["--attach"]) opts.attach = true;
    if (flags["--list"]) opts.listWt = true;
    if (flags["--dry-run"]) opts.dryRun = true;
    if (flags["--from-snapshot"]) opts.fromSnapshot = true;
    if (flags["--snapshot"]) {
      opts.snapshotId = flags["--snapshot"];
      opts.fromSnapshot = true;
    }
    if (flags["--main"]) opts.noRehydrate = true;
    if (flags["--split"]) opts.split = true;
    if (flags["--split-target"]) opts.splitTarget = flags["--split-target"];
    if (flags["--bring-alias"]) opts.bringAlias = true;
    if (flags["--all-local"]) opts.allLocal = true;
    if (flags["--engine"]) opts.engine = flags["--engine"];

    // Shorthand: --codex, --gemini etc. → engine from config.commands
    // Unknown flags land in flags._ (permissive mode), so scan for --<engine>
    if (!opts.engine) {
      const loadConfig = deps.loadConfig ?? (await import("../config")).loadConfig;
      const commands = loadConfig().commands || {};
      for (const arg of (flags._ as string[])) {
        if (arg.startsWith("--") && commands[arg.slice(2)]) {
          opts.engine = arg.slice(2);
          break;
        }
      }
    }

    await directCmdWake(oracle, opts);
    return;
  }

  if (exportName === "cmdBring") {
    // #1799 — keep bring as a thin wake alias so every wake flag works.
    if (argv.some(a => a === "-h" || a === "--help" || a === "-help")) {
      printBringUsage(log);
      return;
    }
    // #1816 — translate bring-shaped `--to <session>` to wake-shaped
    // `--session <session>` before dispatching. Pure helper, fixture-tested.
    const { translateBringToFlag } = await import("../commands/shared/bring-flags");
    await invokeDirectHandler(
      "../commands/shared/wake-cmd:cmdWake",
      [...translateBringToFlag(argv), "--split", "--bring-alias"],
      deps,
    );
    return;
  }

  if (exportName === "cmdNew") {
    await directCmdNew(argv);
    return;
  }

  if (exportName === "cmdPreflight") {
    const flags = parseFlags(argv, { "--fix": Boolean }, 0);
    await directCmdPreflight({ fix: !!flags["--fix"] });
    return;
  }

  throw new Error(`top-alias: unknown direct-handler export '${exportName}'`);
}
