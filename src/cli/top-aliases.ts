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
  split: "Split pane and attach to a session",
  open: "Bring back hidden panes (join-pane)",
  close: "Hide panes without killing (break-pane)",
  t: "Team — create, spawn, send, shutdown",
  layout: "Apply team layout (main-vertical or tiled)",
  zoom: "Toggle zoom on a pane",
  panes: "List all panes across sessions",
  cleanup: "Kill zombie agent panes",
  tile: "Tile current window or spawn N panes tiled",
  bring: "Bring an oracle HERE — split current pane and attach",
  b: "Bring an oracle HERE (short form of `bring`)",
  ls: "List sessions (detail default, -c compact, -a roster)",
  wake: "Wake an oracle session (fuzzy match, auto-clone)",
  awake: "Launch an oracle process with optional engine (does not trigger /awaken)",
  new: "Create a new oracle (friendly door for awaken)",
  preflight: "Pre-flight check — version, plugins, dead agents, config",
};

export const TOP_ALIASES: Record<string, string[] | DirectHandler> = {
  // Argv-rewrite form — canonical handler lives in a core plugin
  a: ["tmux", "attach"],
  kill: ["tmux", "kill"],
  split: ["split"],
  open: ["tmux", "open"],
  close: ["tmux", "close"],
  t: ["team"],
  layout: ["team", "layout"],
  zoom: ["tmux", "zoom"],
  panes: ["tmux", "ls", "--all", "--verbose"],
  cleanup: ["team", "cleanup", "--zombie-agents"],
  tile: ["tile"],
  bring: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdBring" },
  b: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdBring" },

  // Direct-handler form — `ls` flags differ from tmux ls:
  //   maw ls      → full per-pane detail (#1556)
  //   maw ls -v   → no-op alias for muscle memory (same as default)
  //   maw ls -c   → compact live-session summary
  //   maw ls -a   → compact + sleeping oracles (roster; legacy behavior)
  ls: { kind: "direct", handler: "cmdLs" },

  // Direct-handler form — cmdWake is in core (src/commands/shared/wake-cmd.ts)
  // even though the wake/ plugin was extracted to the registry in #918.
  wake: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdWake" },
  awake: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdAwake" },
  new: { kind: "direct", handler: "./cmd-new:cmdNew" },

  preflight: { kind: "direct", handler: "../commands/shared/preflight:cmdPreflight" },
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

export function parseBringArgs(argv: string[]): {
  oracle: string;
  opts: { bring?: true; split?: boolean; tab?: boolean; engine?: string };
} {
  // v1 default (#1398, locked by #1430): `maw bring <oracle>` splits the
  // current pane and attaches there. `--split` is kept as a no-op alias for
  // muscle memory, while `--tab` preserves the background tmux-window path.
  // The top-right respawn experiment (#1422) is deliberately not wired to
  // `--tab`: tab must be non-destructive.
  const flags = parseFlags(argv, {
    "--engine": String, "-e": "--engine",
    "--split": Boolean,
    "--tab": Boolean,
  }, 0);
  const oracle = (flags._ as string[])[0];
  if (!oracle) {
    printBringUsage(console.error);
    throw new UserError("bring: missing oracle name");
  }
  const opts: { bring?: true; split?: boolean; tab?: boolean; engine?: string } = flags["--tab"]
    ? { bring: true, tab: true }
    : { split: true };
  if (flags["--engine"]) opts.engine = flags["--engine"];
  return { oracle, opts };
}

function printBringUsage(write: (line: string) => void = console.log): void {
  write("usage: maw bring <oracle> [--split|--tab] [-e|--engine <name>]");
  write("       maw b <oracle> [--split|--tab] [-e|--engine <name>]");
  write("  Default: split the current pane and attach (v1).");
  write("  --split is accepted as an explicit alias of the default.");
  write("  Use --tab for a non-destructive background tmux window.");
  write("  Symmetric with `maw a` (attach goes there, bring comes here).");
}

function printWakeAliasUsage(verb: "wake" | "awake", write: (line: string) => void = console.log): void {
  write(`usage: maw ${verb} <oracle> [--task <s>] [--wt <s>] [-p|--prompt <s>] [--incubate <slug>] [--fresh] [-a|--attach] [--list] [--split] [--all-local] [-e|--engine <name>]`);
  if (verb === "awake") {
    write("  Launch/start an oracle process with the selected engine. Does not send /awaken.");
    write("  Use `maw awaken` for the awakening ritual; use `maw new` for the creation door.");
  } else {
    write("  Wake or reuse an oracle session, fuzzy-resolving repos and worktrees as needed.");
  }
}

/**
 * Invoke a direct-handler alias. Used by `wake` and `ls`.
 *
 * Handler spec format kept as "<path>:<exportName>" for documentation +
 * help-text rendering, but the path is no longer used at runtime —
 * dispatch is by `exportName` against a static handler map.
 *
 * For `ls`, detail is the default; `-v` is a no-op alias, `-c` returns the
 * compact summary, and `-a` preserves the legacy compact+roster behavior.
 * For `wake`, parses the 9 known flags and calls cmdWake(oracle, opts).
 */
export function parseLsAliasOpts(argv: string[]) {
  const flags = parseFlags(argv, {
    "--all": Boolean, "-a": "--all",
    "--compact": Boolean, "-c": "--compact",
    "--verbose": Boolean, "-v": "--verbose",
    "--fix": Boolean,
    "--json": Boolean,
  }, 0);

  // #1556 — Nat's UX preference: detailed per-pane output is the default,
  // `-v` stays accepted as a no-op muscle-memory alias, and `-c/--compact`
  // is the opt-in condensed summary. `-a/--all` historically meant
  // "include sleeping roster" on top-level `maw ls`; keep that legacy shape
  // by rendering the compact roster view.
  const compact = !!flags["--compact"] || !!flags["--all"];
  return {
    all: true,
    compact,
    verbose: !compact,
    roster: !!flags["--all"],
    json: !!flags["--json"],
  };
}

export async function invokeDirectHandler(
  handler: string,
  argv: string[],
): Promise<void> {
  const exportName = handler.includes(":") ? handler.split(":")[1] : handler;
  if (!exportName) {
    throw new Error(`top-alias: malformed handler spec '${handler}' — expected '<module>:<export>' or name`);
  }

  if (exportName === "cmdLs") {
    await cmdTmuxLs(parseLsAliasOpts(argv));
    return;
  }

  if (exportName === "cmdWake" || exportName === "cmdAwake") {
    const verb = exportName === "cmdAwake" ? "awake" : "wake";
    if (argv.some(a => a === "-h" || a === "--help" || a === "-help")) {
      printWakeAliasUsage(verb);
      return;
    }

    const flags = parseFlags(argv, {
      "--task": String,
      "--wt": String,
      "--prompt": String, "-p": "--prompt",
      "--incubate": String,
      "--fresh": Boolean,
      "--attach": Boolean, "-a": "--attach",
      "--list": Boolean,
      "--split": Boolean,
      "--all-local": Boolean,
      "--engine": String, "-e": "--engine",
    }, 0);

    const positional = flags._;
    const oracle = positional[0];
    if (!oracle) {
      printWakeAliasUsage(verb, console.error);
      throw new UserError(`${verb}: missing oracle name`);
    }

    const opts: {
      task?: string;
      wt?: string;
      prompt?: string;
      incubate?: string;
      fresh?: boolean;
      attach?: boolean;
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

  if (exportName === "cmdBring") {
    // `maw bring <oracle>` defaults to the v1 current-pane split path.
    // `--tab` opts into the non-destructive background tmux-window path.
    if (argv.some(a => a === "-h" || a === "--help" || a === "-help")) {
      printBringUsage();
      return;
    }
    const { oracle, opts } = parseBringArgs(argv);
    await cmdWake(oracle, opts);
    return;
  }

  if (exportName === "cmdNew") {
    await cmdNew(argv);
    return;
  }

  if (exportName === "cmdPreflight") {
    const flags = parseFlags(argv, { "--fix": Boolean }, 0);
    await cmdPreflight({ fix: !!flags["--fix"] });
    return;
  }

  throw new Error(`top-alias: unknown direct-handler export '${exportName}'`);
}
