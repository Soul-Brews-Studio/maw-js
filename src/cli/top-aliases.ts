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
import { cmdShow } from "../commands/shared/wake-show";
import { cmdTmuxLs } from "../commands/plugins/tmux/impl";
import { cmdPreflight } from "../commands/shared/preflight";
import { cmdNew } from "./cmd-new";
import { parseFlags } from "./parse-args";
import { UserError } from "../core/util/user-error";

export type DirectHandler = { kind: "direct"; handler: string };
export type AliasResolution =
  | { kind: "argv"; argv: string[] }
  | { kind: "direct"; handler: string; argv: string[] };

export const ALIAS_DESCRIPTIONS: Record<string, string> = {
  a: "Attach to a tmux session",
  kill: "Kill a tmux pane or session",
  peek: "Read content of a tmux pane",
  split: "Split pane and attach to a session",
  open: "Bring back hidden panes (join-pane)",
  close: "Hide panes without killing (break-pane)",
  t: "Team — create, spawn, send, shutdown",
  layout: "Apply team layout (main-vertical or tiled)",
  zoom: "Toggle zoom on a pane",
  panes: "List all panes across sessions",
  cleanup: "Kill zombie agent panes",
  ls: "List sessions (compact, -a roster, -v detail)",
  wake: "Wake an oracle session (fuzzy match, auto-clone)",
  preflight: "Pre-flight check — version, plugins, dead agents, config",
  stall: "Detect stalled panes — notify-only (#976A)",
  show: "Print session launch script to stdout (pipe-able)",
  new: "Create a new oracle (alias for awaken — friendly door)",
};

export const TOP_ALIASES: Record<string, string[] | DirectHandler> = {
  // Argv-rewrite form — canonical handler lives in a top-level plugin in
  // maw-plugin-registry. The previous `["tmux", X]` rewrites were stale —
  // the `tmux` plugin was split into per-verb top-level plugins
  // (attach/, kill/, peek/, zoom/, panes/) but the alias table was not
  // updated. Result: `maw a flutter` rewrote to `maw tmux attach flutter`
  // → "unknown command: tmux" → fell through to bare-name comm-send.
  // Same shape as the #1244 cleanup alias bug. (#TBD)
  a: ["attach"],
  kill: ["kill"],
  peek: ["peek"],
  split: ["split"],
  open: ["tmux", "open"],     // tmux open/close/detect-stalls not yet extracted as top-level plugins
  close: ["tmux", "close"],
  t: ["team"],
  layout: ["team", "layout"],
  zoom: ["zoom"],
  panes: ["panes"],
  // `maw cleanup` → `maw cleanup --zombie-agents` (auto-inject flag for the
  // top-level cleanup plugin in maw-plugin-registry). The previous rewrite
  // `["team", "cleanup", ...]` was wrong — the `team` plugin has no `cleanup`
  // subcommand; the cleanup plugin sits at the top level. Resolver runs once
  // (dispatch.ts:36), so the self-reference doesn't loop. (#1244)
  cleanup: ["cleanup", "--zombie-agents"],
  stall: ["tmux", "detect-stalls"],   // detect-stalls not yet extracted as top-level plugin

  // `maw new <name>` — the friendly door for creating an oracle.
  // Routes through cmdNew (direct handler) which wraps the awaken plugin
  // with a TTY-aware "Attach now? [Y/n]" prompt (#1272). cmdNew strips its
  // own flags (--no-attach, --auto-attach, -y) and passes everything else
  // through to awaken, then handles the attach step.
  new: { kind: "direct", handler: "./cmd-new:cmdNew" },

  // Direct-handler form — `ls` flags differ from tmux ls:
  //   maw ls      → compact, live sessions only
  //   maw ls -a   → compact + sleeping oracles (roster)
  //   maw ls -v   → full per-pane detail
  ls: { kind: "direct", handler: "cmdLs" },

  // Direct-handler form — cmdWake is in core (src/commands/shared/wake-cmd.ts)
  // even though the wake/ plugin was extracted to the registry in #918.
  wake: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdWake" },

  preflight: { kind: "direct", handler: "../commands/shared/preflight:cmdPreflight" },

  show: { kind: "direct", handler: "../commands/shared/wake-show:cmdShow" },
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

  if (Array.isArray(entry)) {
    // Argv-rewrite: replace args[0] with the canonical chain, keep rest.
    return { kind: "argv", argv: [...entry, ...args.slice(1)] };
  }

  // Direct-handler: pass the rest of argv (everything after the verb) as-is.
  return { kind: "direct", handler: entry.handler, argv: args.slice(1) };
}

/**
 * Invoke a direct-handler alias. Used by `wake` and `ls`.
 *
 * Handler spec format kept as "<path>:<exportName>" for documentation +
 * help-text rendering, but the path is no longer used at runtime —
 * dispatch is by `exportName` against a static handler map.
 *
 * For `ls`, `-a` = roster (sleeping oracles), `-v` = full detail.
 * For `wake`, parses the 9 known flags and calls cmdWake(oracle, opts).
 */
export async function invokeDirectHandler(
  handler: string,
  argv: string[],
): Promise<void> {
  const exportName = handler.includes(":") ? handler.split(":")[1] : handler;
  if (!exportName) {
    throw new Error(`top-alias: malformed handler spec '${handler}' — expected '<module>:<export>' or name`);
  }

  if (exportName === "cmdLs") {
    const flags = parseFlags(argv, {
      "--all": Boolean, "-a": "--all",
      "--verbose": Boolean, "-v": "--verbose",
      "--fix": Boolean,
      "--json": Boolean,
    }, 0);
    await cmdTmuxLs({
      all: true,
      compact: !flags["--verbose"],
      verbose: !!flags["--verbose"],
      roster: !!flags["--all"],
      json: !!flags["--json"],
    });
    return;
  }

  if (exportName === "cmdWake") {
    const flags = parseFlags(argv, {
      "--task": String,
      "--wt": String,
      "--prompt": String, "-p": "--prompt",
      "--incubate": String,
      "--fresh": Boolean,
      "--attach": Boolean, "-a": "--attach",
      "--no-attach": Boolean,
      "--list": Boolean,
      "--split": Boolean,
      "--all-local": Boolean,
      "--engine": String, "-e": "--engine",
      "--dry-run": Boolean,
    }, 0);

    const positional = flags._;
    const oracle = positional[0];
    if (!oracle) {
      console.error("usage: maw wake <oracle> [--task <s>] [--wt <s>] [-p|--prompt <s>] [--incubate <slug>] [--fresh] [-a|--attach] [--no-attach] [--list] [--split] [--all-local] [-e|--engine <name>] [--dry-run]\n       maw wake all [--kill] [--all] [--resume]");
      throw new UserError("wake: missing oracle name");
    }

    // Pre-#918 the wake/ plugin handled `maw wake all` by routing to cmdWakeAll.
    // When wake routing moved to top-aliases the early-route was lost, so "all"
    // started resolving as a literal oracle name (#918 regression surfaced via
    // pulse-oracle 2026-05-06 maw-boot incident). Restore the routing here.
    if (oracle.toLowerCase() === "all") {
      const allFlags = parseFlags(argv, {
        "--kill": Boolean,
        "--all": Boolean,
        "--resume": Boolean,
      }, 0);
      const { cmdWakeAll } = await import("../commands/shared/fleet-wake");
      await cmdWakeAll({
        kill: !!allFlags["--kill"],
        all: !!allFlags["--all"],
        resume: !!allFlags["--resume"],
      });
      return;
    }

    if (flags["--dry-run"]) {
      const { resolveOracle } = await import("../commands/shared/wake-resolve-impl");
      const { detectSession } = await import("../commands/shared/wake-resolve-impl");
      try {
        const repo = await resolveOracle(oracle);
        const session = await detectSession(oracle);
        console.log(`\x1b[36m⚡\x1b[0m [dry-run] resolved: ${oracle}`);
        console.log(`\x1b[36m→\x1b[0m [dry-run] would use repo: ${repo.repoPath}`);
        console.log(session
          ? `\x1b[36m→\x1b[0m [dry-run] would attach to session: ${session}`
          : `\x1b[36m→\x1b[0m [dry-run] would create new session for: ${oracle}`);
        console.log(`\x1b[90m  no changes made.\x1b[0m`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`\x1b[31m✗\x1b[0m [dry-run] resolution failed: ${msg}`);
      }
      return;
    }

    const opts: {
      task?: string;
      wt?: string;
      prompt?: string;
      incubate?: string;
      fresh?: boolean;
      attach?: boolean;
      noAttach?: boolean;
      listWt?: boolean;
      split?: boolean;
      allLocal?: boolean;
      engine?: string;
    } = {};
    if (flags["--task"]) opts.task = flags["--task"];
    if (flags["--wt"]) opts.wt = flags["--wt"];
    if (flags["--prompt"]) opts.prompt = flags["--prompt"];
    if (flags["--incubate"]) opts.incubate = flags["--incubate"];
    if (flags["--fresh"]) opts.fresh = true;
    if (flags["--attach"]) opts.attach = true;
    if (flags["--no-attach"]) opts.noAttach = true;
    if (flags["--list"]) opts.listWt = true;
    if (flags["--split"]) opts.split = true;
    if (flags["--all-local"]) opts.allLocal = true;
    if (flags["--engine"]) opts.engine = flags["--engine"];

    // Shorthand: --codex, --gemini etc. → engine from config.commands
    // Unknown flags land in flags._ (permissive mode), so scan for --<engine>
    if (!opts.engine) {
      const { loadConfig } = await import("../config");
      const commands = loadConfig().commands || {};
      for (const arg of (flags._ as string[])) {
        if (arg.startsWith("--") && commands[arg.slice(2)]) {
          opts.engine = arg.slice(2);
          break;
        }
      }
    }

    await cmdWake(oracle, opts);
    return;
  }

  if (exportName === "cmdPreflight") {
    const flags = parseFlags(argv, { "--fix": Boolean }, 0);
    await cmdPreflight({ fix: !!flags["--fix"] });
    return;
  }

  if (exportName === "cmdNew") {
    await cmdNew(argv);
    return;
  }

  if (exportName === "cmdShow") {
    const oracle = argv[0];
    if (!oracle) {
      console.error("usage: maw show <oracle> [--engine <name>]");
      process.exit(1);
    }
    const engineIdx = argv.indexOf("--engine");
    const engine = engineIdx !== -1 ? argv[engineIdx + 1] : undefined;
    await cmdShow(oracle, { engine });
    return;
  }

  throw new Error(`top-alias: unknown direct-handler export '${exportName}'`);
}
