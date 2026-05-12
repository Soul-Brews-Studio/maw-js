/**
 * `maw new` — TTY-aware oracle creation with attach prompt (#1272).
 *
 * Delegates creation to the awaken plugin (which buds + wakes + fires
 * /awaken), then offers to attach. Behavior is TTY-aware:
 *
 *   --no-attach            never attach, print session ref
 *   --auto-attach / -y     skip prompt, attach immediately
 *   MAW_NO_PROMPT=1        env equivalent of --no-attach
 *   TTY (default)          prompt "Attach now? [Y/n]" (default yes)
 *   non-TTY (default)      silent auto-attach
 *
 * Implementation note (PR #1272):
 *   The "create oracle" surface today is `maw awaken` (plugin in the
 *   maw-plugin-registry repo) — `maw bud` does the bud half, `maw awaken`
 *   composes bud + wake + fire `/awaken`. Neither lives inside maw-js as a
 *   command source. `maw new` was previously an argv-rewrite alias to
 *   awaken; we promote it to a direct handler so the prompt lives at the
 *   verb level without forking the registry plugin.
 *
 *   Awaken's own pre-create confirmation ("Will create: ... Proceed? [y/N]")
 *   is preserved. `maw new foo -y` skips BOTH that and our attach prompt
 *   in a single keystroke — the "I know what I'm doing" path.
 */

import { parseFlags } from "./parse-args";
import { UserError } from "../core/util/user-error";

/** Decision returned by {@link decideAttachAction}. Stable for testing/logs. */
export type AttachDecision =
  | { action: "attach"; reason: string }
  | { action: "skip"; reason: "no-attach-flag" | "env-no-prompt" | "already-attached" | "user-declined" }
  | { action: "prompt"; reason: string }
  | { action: "abort"; reason: "creation-failed" };

/** Inputs to {@link decideAttachAction}. All facts pre-collected by the caller. */
export interface DecideAttachOpts {
  /** --no-attach flag. */
  noAttach: boolean;
  /** --auto-attach / -y flag (either implies attach without prompt). */
  autoAttach: boolean;
  /** MAW_NO_PROMPT=1 (or any truthy value) — env override for --no-attach. */
  envNoPrompt: boolean;
  /** process.stdin.isTTY at call time. */
  stdinIsTTY: boolean;
  /** process.stdout.isTTY at call time. */
  stdoutIsTTY: boolean;
  /** Was oracle creation successful? false → abort, don't prompt. */
  creationOk: boolean;
  /** Are we already inside this oracle's tmux session? true → no-op. */
  alreadyAttached: boolean;
}

/**
 * Pure decision for the post-create attach step. Priority (highest first):
 *
 *   1. creation failed            → abort
 *   2. already attached           → skip (no-op)
 *   3. --no-attach                → skip
 *   4. MAW_NO_PROMPT=1            → skip
 *   5. --auto-attach / -y         → attach
 *   6. both stdin & stdout TTY    → prompt
 *   7. otherwise (non-TTY)        → attach (silent default)
 *
 * No I/O — caller renders the decision (prompt UI, attach call, exit).
 */
export function decideAttachAction(opts: DecideAttachOpts): AttachDecision {
  if (!opts.creationOk) return { action: "abort", reason: "creation-failed" };
  if (opts.alreadyAttached) return { action: "skip", reason: "already-attached" };
  if (opts.noAttach) return { action: "skip", reason: "no-attach-flag" };
  if (opts.envNoPrompt) return { action: "skip", reason: "env-no-prompt" };
  if (opts.autoAttach) return { action: "attach", reason: "auto-attach flag" };
  if (opts.stdinIsTTY && opts.stdoutIsTTY) return { action: "prompt", reason: "interactive TTY" };
  return { action: "attach", reason: "non-TTY silent default" };
}

/**
 * Interpret a y/n answer where Enter (empty) defaults to YES.
 *
 *   "" / "\n"         → true   (Enter = default yes)
 *   "y" / "Y" / "yes" → true
 *   anything else     → false  ("n", "N", "no", garbage)
 */
export function interpretYesNoDefaultYes(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  if (t === "") return true;
  if (t === "y" || t === "yes") return true;
  return false;
}

/** Truthy env values: "1", "true", "yes", "on" (case-insensitive). */
export function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

/**
 * Read a single line from /dev/tty so a piped stdin can't break the prompt.
 * Mirrors the helper in maw-plugin-registry's awaken/attach plugins.
 */
function readLineFromTty(question: string): string {
  const fs = require("fs");
  let fd: number | null = null;
  try {
    fd = fs.openSync("/dev/tty", "r");
    process.stderr.write(question);
    const buf = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, buf, 0, 64, null);
    return buf.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Best-effort check: are we already inside the target oracle's tmux session?
 * Strips the `NN-` prefix (fleet sessions are `42-foo` for oracle `foo`).
 *
 * Returns false on any failure (no TMUX, tmux not on PATH, etc).
 */
async function detectAlreadyAttached(name: string): Promise<boolean> {
  if (!process.env.TMUX) return false;
  try {
    const proc = Bun.spawn(["tmux", "display-message", "-p", "#S"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const sessionName = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!sessionName) return false;
    const stripped = sessionName.replace(/^\d+-/, "");
    return stripped === name || sessionName === name;
  } catch {
    return false;
  }
}

/** Filter the raw argv to remove flags consumed by cmdNew itself. */
export function stripCmdNewFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === "--no-attach" || a === "--auto-attach") continue;
    if (a === "-y" || a === "--yes") continue;
    out.push(a);
  }
  return out;
}

/**
 * Implementation of `maw new <name> [flags...]`.
 *
 * 1. Parse our own flags (--no-attach, --auto-attach, -y).
 * 2. Pass remaining args through to the awaken plugin.
 * 3. After awaken returns, decide+execute the attach step.
 */
export async function cmdNew(argv: string[]): Promise<void> {
  const flags = parseFlags(
    argv,
    {
      "--no-attach": Boolean,
      "--auto-attach": Boolean,
      "--yes": Boolean,
      "-y": "--yes",
    },
    0,
  );

  const positional = flags._;
  const name = positional[0];
  if (!name || name === "--help" || name === "-h") {
    console.error(
      "usage: maw new <name> [--no-attach] [--auto-attach|-y] [awaken flags...]",
    );
    throw new UserError("new: missing oracle name");
  }
  if (name.startsWith("-")) {
    console.error(`"${name}" looks like a flag, not an oracle name.`);
    throw new UserError(`new: invalid name '${name}'`);
  }

  const noAttach = !!flags["--no-attach"];
  const autoAttach = !!flags["--auto-attach"] || !!flags["--yes"];
  const envNoPrompt = isTruthyEnv(process.env.MAW_NO_PROMPT);

  // Forward args to awaken with our flags stripped. -y carries the same
  // "I know what I'm doing" intent through to awaken's pre-create confirm.
  const awakenArgs = stripCmdNewFlags(argv);
  if (autoAttach) awakenArgs.push("-y");

  // 1. Invoke the awaken plugin.
  const { discoverPackages, invokePlugin } = await import("../plugin/registry");
  const { resolvePluginMatch } = await import("./dispatch-match");
  const plugins = discoverPackages();
  const awakenMatch = resolvePluginMatch(plugins, "awaken");
  if (awakenMatch.kind !== "match") {
    console.error(
      "\x1b[31m✗\x1b[0m awaken plugin not installed — run `maw plugin install awaken`",
    );
    throw new UserError("new: awaken plugin not found");
  }

  const result = await invokePlugin(awakenMatch.plugin, {
    source: "cli",
    args: awakenArgs,
  });

  if (!result.ok) {
    if (result.error) console.error(result.error);
    console.error(`\x1b[31m✗\x1b[0m creation failed`);
    console.error(
      `\x1b[90m  cleanup hint: maw kill ${name} (then remove the repo dir if it was created)\x1b[0m`,
    );
    throw new UserError("new: creation failed");
  }

  // 2. Decide and execute the attach step.
  const alreadyAttached = await detectAlreadyAttached(name);
  const decision = decideAttachAction({
    noAttach,
    autoAttach,
    envNoPrompt,
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
    creationOk: true,
    alreadyAttached,
  });

  if (decision.action === "skip") {
    if (decision.reason === "already-attached") {
      console.log(`\x1b[90m  · already attached to ${name}\x1b[0m`);
      return;
    }
    console.log(
      `\x1b[36m💡\x1b[0m Attach later: \x1b[36mmaw a ${name}\x1b[0m`,
    );
    return;
  }

  let shouldAttach = decision.action === "attach";
  if (decision.action === "prompt") {
    const answer = readLineFromTty("Attach now? [Y/n] ");
    shouldAttach = interpretYesNoDefaultYes(answer);
    if (!shouldAttach) {
      console.log(
        `\x1b[36m💡\x1b[0m Attach later: \x1b[36mmaw a ${name}\x1b[0m`,
      );
      return;
    }
  }

  if (shouldAttach) await invokeAttach(name);
}

async function invokeAttach(name: string): Promise<void> {
  const { discoverPackages, invokePlugin } = await import("../plugin/registry");
  const { resolvePluginMatch } = await import("./dispatch-match");
  const plugins = discoverPackages();
  const attachMatch = resolvePluginMatch(plugins, "attach");
  if (attachMatch.kind !== "match") {
    console.error("\x1b[33m⚠\x1b[0m attach plugin not installed");
    console.log(
      `\x1b[36m💡\x1b[0m Attach manually: \x1b[36mmaw a ${name}\x1b[0m`,
    );
    return;
  }
  const result = await invokePlugin(attachMatch.plugin, {
    source: "cli",
    args: [name],
  });
  if (!result.ok && result.error) {
    console.error(result.error);
    console.log(`\x1b[36m💡\x1b[0m Retry: \x1b[36mmaw a ${name}\x1b[0m`);
  }
}
