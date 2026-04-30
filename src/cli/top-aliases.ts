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
import { parseFlags } from "./parse-args";
import { UserError } from "../core/util/user-error";

export type DirectHandler = { kind: "direct"; handler: string };
export type AliasResolution =
  | { kind: "argv"; argv: string[] }
  | { kind: "direct"; handler: string; argv: string[] };

export const TOP_ALIASES: Record<string, string[] | DirectHandler> = {
  // Argv-rewrite form — canonical handler lives in a core plugin
  a: ["tmux", "attach"],
  kill: ["tmux", "kill"],
  peek: ["tmux", "peek"],
  split: ["split"],
  unsplit: ["tmux", "unsplit"],
  t: ["team"],
  cleanup: ["team", "cleanup", "--zombie-agents"],

  // Direct-handler form — `ls` flags differ from tmux ls:
  //   maw ls      → compact, live sessions only
  //   maw ls -a   → compact + sleeping oracles (roster)
  //   maw ls -v   → full per-pane detail
  ls: { kind: "direct", handler: "cmdLs" },

  // Direct-handler form — cmdWake is in core (src/commands/shared/wake-cmd.ts)
  // even though the wake/ plugin was extracted to the registry in #918.
  wake: { kind: "direct", handler: "../commands/shared/wake-cmd:cmdWake" },
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
      "--list": Boolean,
      "--split": Boolean,
      "--all-local": Boolean,
    }, 0);

    const positional = flags._;
    const oracle = positional[0];
    if (!oracle) {
      console.error("usage: maw wake <oracle> [--task <s>] [--wt <s>] [-p|--prompt <s>] [--incubate <slug>] [--fresh] [-a|--attach] [--list] [--split] [--all-local]");
      throw new UserError("wake: missing oracle name");
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

    await cmdWake(oracle, opts);
    return;
  }

  throw new Error(`top-alias: unknown direct-handler export '${exportName}'`);
}
