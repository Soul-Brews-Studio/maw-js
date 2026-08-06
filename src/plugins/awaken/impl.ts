/**
 * awaken — bud a new oracle then fire /awaken into its Claude TUI.
 *
 * Composition:
 *   1. cmdBud(name, opts) — creates repo, ψ vault, fleet config, AND wakes
 *      the oracle with noAttach (cmdBud already calls cmdWake at step 8).
 *   2. resolveTarget(name) — finds the freshly-woken pane.
 *   3. cmdSendText({ target, text: trigger }) — types `/awaken` + Enter
 *      into the Claude prompt.
 *
 * This is `maw bud` + the awakening ritual, in one verb. Without --no-trigger,
 * the new oracle is fully alive and starting its /awaken skill by the time
 * `maw awaken` returns.
 *
 * Flags mirror `maw bud` exactly + 2 awaken-specific:
 *   --trigger <text>   custom slash command to send (default: /awaken)
 *   --no-trigger       bud + wake but skip the slash command (debug)
 */
import { cmdBud, type BudOpts } from "../bud/impl";
import { cmdSendText } from "../send-text/impl";
import { listSessions, resolveTarget, getPaneCommand, isAgentCommand } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";

export interface AwakenOpts extends BudOpts {
  /** Slash command to fire after wake. Default: "/awaken". */
  trigger?: string;
  /** Skip the trigger send entirely (just bud+wake). */
  noTrigger?: boolean;
  /** `-y/--yes` — skip the human-confirmation prompt (#31). */
  yes?: boolean;
}

const DEFAULT_TRIGGER = "/awaken";

/**
 * Confirmation prompt decision table (#31):
 *   TTY + no -y + no --dry-run  → prompt
 *   anything else                → skip
 *
 * Non-TTY (piped / scripted / agent) is treated as `-y` per Unix convention.
 * --dry-run shows the plan unconditionally via cmdBud, no destructive action.
 */
function isPromptingNeeded(opts: AwakenOpts): boolean {
  if (opts.yes) return false;
  if (opts.dryRun) return false;
  return Boolean(process.stdin.isTTY);
}

function summarizePlan(name: string, opts: AwakenOpts): string {
  const lines: string[] = [`  Will create:`, `    oracle:  ${name}`];
  if (opts.repo) lines.push(`    repo:    ${opts.repo}`);
  else if (opts.org) lines.push(`    org:     ${opts.org}`);
  if (opts.from) lines.push(`    from:    ${opts.from}`);
  else if (opts.root) lines.push(`    parent:  root (no lineage)`);
  const trigger = opts.noTrigger ? "(none — --no-trigger)" : (opts.trigger ?? DEFAULT_TRIGGER);
  lines.push(`    trigger: ${trigger}`);
  if (opts.fast) lines.push(`    mode:    fast (skip soul sync)`);
  if (opts.seed) lines.push(`    mode:    seed (new mind)`);
  if (opts.blank) lines.push(`    mode:    blank (no soul)`);
  if (opts.split) lines.push(`    layout:  split pane`);
  return lines.join("\n");
}

/**
 * Read a single y/n from /dev/tty so a piped stdin (which might be consumed
 * by an upstream tool) can't break the prompt. Defaults to N on any error
 * or non-y answer.
 */
function askYesNo(question: string): boolean {
  const fs = require("fs");
  let fd: number | null = null;
  try {
    fd = fs.openSync("/dev/tty", "r");
    process.stderr.write(question);
    const buf = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, buf, 0, 8, null);
    const answer = buf.toString("utf-8", 0, bytesRead).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

export async function cmdAwaken(name: string, opts: AwakenOpts = {}): Promise<void> {
  if (isPromptingNeeded(opts)) {
    console.log(summarizePlan(name, opts));
    if (!askYesNo("  Proceed? [y/N] ")) {
      console.log("  aborted — no changes made.");
      return;
    }
  }

  const trigger = opts.noTrigger ? null : (opts.trigger ?? DEFAULT_TRIGGER);

  // Step 1: bud (which also wakes via finalizeBud → cmdWake noAttach)
  await cmdBud(name, opts);

  // Dry-run / root-without-wake: bud already returned early, nothing to send
  if (opts.dryRun) {
    if (trigger) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send \x1b[33m${trigger}\x1b[0m to ${name}`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] --no-trigger: would NOT fire /awaken`);
    }
    return;
  }

  if (!trigger) {
    console.log(`  \x1b[90m○\x1b[0m --no-trigger: bud + wake done, skipping /awaken`);
    return;
  }

  // Step 2: resolve the target pane
  const config = loadConfig();
  const sessions = await listSessions();
  const result = resolveTarget(name, config, sessions);

  if (!result || result.type === "error") {
    console.log(
      `  \x1b[33m⚠\x1b[0m could not resolve ${name} after wake — skipping ${trigger}`,
    );
    console.log(`  \x1b[90m  try manually: maw send-text ${name} ${trigger}\x1b[0m`);
    return;
  }

  // Step 2.5: wait for Claude (or other agent) to be running in the pane.
  // Fixes registry#28 — without this, /awaken arrives before Claude TUI is
  // ready and the text lands in the bare zsh prompt (`zsh: no such file or
  // directory: /awaken`). Poll getPaneCommand(target) until isAgentCommand
  // returns true. Max wait ~10s — Claude cold start is usually 2-5s on m5.
  const target = result.target;
  const POLL_INTERVAL_MS = 500;
  const MAX_WAIT_MS = 10000;
  const deadline = Date.now() + MAX_WAIT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const paneCmd = await getPaneCommand(target);
      if (isAgentCommand(paneCmd)) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!ready) {
    console.log(
      `  \x1b[33m⚠\x1b[0m timeout waiting for agent in ${target} after ${MAX_WAIT_MS}ms`,
    );
    console.log(`  \x1b[90m  pane may still be in zsh — try manually: maw send-text ${name} ${trigger}\x1b[0m`);
    return;
  }

  // Step 3: fire the trigger (e.g. /awaken)
  console.log(`  \x1b[36m🔔\x1b[0m firing \x1b[33m${trigger}\x1b[0m → ${name}`);
  try {
    await cmdSendText({ target: name, text: trigger });
    console.log(`  \x1b[32m✓\x1b[0m awakened`);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m send-text failed: ${e?.message || e}`);
    console.log(`  \x1b[90m  try manually: maw send-text ${name} ${trigger}\x1b[0m`);
  }
}
