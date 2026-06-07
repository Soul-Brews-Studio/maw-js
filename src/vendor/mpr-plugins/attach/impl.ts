/**
 * `maw attach <name>` cascade — Phase 1 (#25) — Smart Local.
 *
 *   Tier 1 (live):     attach immediately via the tmux attach implementation
 *   Tier 2 (sleeping): prompt → `maw wake <fleet-name>` → attach
 *   no match:          error + list of available oracles
 *
 * Cross-node attach (Tier 3) used to live here. It was pulled back out —
 * the built-in stays local-only. Federation lives in the `attach-ssh`
 * plugin (registry). Install it if you want cross-node attach.
 */
import { listSessions } from "maw-js/sdk";
import { loadFleet } from "maw-js/commands/shared/fleet-load";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { cmdTmuxAttach } from "../../../commands/plugins/tmux/impl";
import { isClaudeLikePane } from "../../../commands/plugins/tmux/safety";
import { join } from "path";
import {
  resolveAttachTarget,
  type ResolveResult,
} from "./resolve-attach-target";

export interface AttachOpts {
  /** Skip the human-confirmation prompt on Tier 2 (agents / scripted). */
  yes?: boolean;
  /** Show what the cascade picked + planned action, no side effects. */
  dryRun?: boolean;
  /** Open a shell at the oracle repo instead of attaching to the agent pane. */
  shell?: boolean;
  /** For shell mode: split a pane by default; false opens a new window. */
  split?: boolean;
}

type FleetSessionLike = {
  name: string;
  windows: Array<{ name: string; repo?: string }>;
};

/**
 * Read a single y/n from /dev/tty (not stdin) so a piped upstream tool can't
 * break the prompt. Defaults to N on error or any non-y answer.
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

export async function cmdAttach(name: string, opts: AttachOpts = {}): Promise<void> {
  if (!name) {
    console.error("usage: maw attach <name> [--shell [--split|--no-split]] [--dry-run] [-y|--yes]");
    throw new Error("name required");
  }

  const deps = { listSessions, loadFleet };
  const result: ResolveResult = await resolveAttachTarget(name, deps);

  if (!result) {
    // Local Tier 1+2 missed. Delegate to wake — it runs the full chain:
    // ghqFind → fleet pin → worktree → ghq get -u clone → GitHub org scan →
    // scanSuggestOracle interactive "Scan now? [y/N]" → wake.
    // After wake, re-resolve — should now be Tier 1 → attach.
    // See ψ/memory/traces/2026-05-13/1203_attach-find-or-scan-flow.md
    if (opts.dryRun) {
      const action = opts.shell ? "open shell" : "attach";
      console.log(`  \x1b[36m·\x1b[0m [dry-run] '${name}' not local — would: maw wake ${name} → re-resolve → ${action}`);
      return;
    }
    console.log(`  \x1b[36m·\x1b[0m '${name}' not local — delegating to wake`);
    await spawnMaw(["wake", name]);
    // Wake created the session. Re-resolve — should hit Tier 1 now.
    //
    // #1342 — wake fuzzy-resolves the original input (e.g. "wind" →
    // "Somwind-oracle", session "01-Somwind") but doesn't surface the
    // resolved name structurally to this caller. A strict re-resolve using
    // the original input therefore misses the session wake just created.
    // Pass `fuzzy: true` so the second pass uses a case-insensitive
    // substring comparator that matches wake's intent. Wake's success
    // implies a fuzzy match exists; if not, the same `still not running
    // after wake` error fires as before.
    const retried = await resolveAttachTarget(name, deps, { fuzzy: true });
    if (retried && retried.tier === 1) {
      if (opts.shell) {
        await openShellForSession(name, retried.sessionName, opts, deps.loadFleet());
        return;
      }
      console.log(`  \x1b[32m→\x1b[0m attaching to ${retried.sessionName}`);
      await attachToSession(retried.sessionName);
      return;
    }
    console.error(`\x1b[31m✗\x1b[0m '${name}' still not running after wake`);
    throw new Error(`wake did not create a session for '${name}'`);
  }

  // Ambiguous match: list candidates, stop. User picks one and re-runs.
  if (result.ambiguousCandidates && result.ambiguousCandidates.length > 1) {
    console.error(`\x1b[33m⚠\x1b[0m '${name}' is ambiguous — ${result.ambiguousCandidates.length} matches:`);
    for (const c of result.ambiguousCandidates) console.error(`    • ${c}`);
    console.error(`  use the full name: \x1b[36mmaw attach <exact-name>\x1b[0m`);
    throw new Error(`ambiguous: ${name}`);
  }

  if (result.tier === 1) {
    if (opts.shell) {
      await openShellForSession(name, result.sessionName, opts, deps.loadFleet());
      return;
    }
    if (opts.dryRun) {
      console.log(`  \x1b[36m·\x1b[0m [dry-run] Tier 1 (live) — would attach to ${result.sessionName}`);
      return;
    }
    console.log(`  \x1b[32m→\x1b[0m attaching to ${result.sessionName}`);
    await attachToSession(result.sessionName);
    return;
  }

  if (result.tier === 2) {
    if (opts.dryRun) {
      const action = opts.shell ? "open shell" : "attach";
      console.log(`  \x1b[36m·\x1b[0m [dry-run] Tier 2 (sleeping) — would wake ${result.fleetName}, then ${action}`);
      return;
    }

    console.log(`  \x1b[33m○\x1b[0m '${result.fleetName}' is sleeping (fleet-registered, not running)`);
    const promptable = !opts.yes && Boolean(process.stdin.isTTY);
    if (promptable && !askYesNo(`  Wake "${result.fleetName}"? [y/N] `)) {
      console.log("  aborted — no changes made.");
      return;
    }

    console.log(`  \x1b[36m⚡\x1b[0m waking ${result.fleetName}...`);
    await spawnMaw(["wake", result.fleetName]);
    if (opts.shell) {
      await openShellForSession(name, result.fleetName, opts, deps.loadFleet());
      return;
    }
    console.log(`  \x1b[32m→\x1b[0m attaching to ${result.fleetName}`);
    await attachToSession(result.fleetName);
    return;
  }
}

export interface AttachShellPlan {
  sessionName: string;
  targetWindow: string;
  windowName: string;
  cwd: string;
  command: string;
}

export function buildAttachShellPlan(
  requestedName: string,
  sessionName: string,
  fleet: FleetSessionLike[],
): AttachShellPlan {
  const session = fleet.find(f => f.name === sessionName) ??
    fleet.find(f => sessionName.endsWith(`-${f.name}`));
  const window = session?.windows?.[0];
  if (!window?.repo) {
    throw new Error(`cannot resolve repo path for '${requestedName}' in session '${sessionName}'`);
  }
  const cwd = join(getGhqRoot(), window.repo);
  const targetWindow = `${sessionName}:${window.name}`;
  const windowName = `${sanitizeTmuxName(window.name || requestedName)}-shell`.slice(0, 80);
  const command = `cd ${shellArg(cwd)} && exec ${process.env.SHELL || "zsh"}`;
  return { sessionName, targetWindow, windowName, cwd, command };
}

async function openShellForSession(
  requestedName: string,
  sessionName: string,
  opts: AttachOpts,
  fleet: FleetSessionLike[],
): Promise<void> {
  const plan = buildAttachShellPlan(requestedName, sessionName, fleet);
  const split = opts.split !== false;
  const claudeLikeCaller = split ? await isClaudeLikeCaller() : false;
  const useSplit = split && !claudeLikeCaller;

  if (opts.dryRun) {
    const mode = useSplit ? "split shell pane" : "new shell window";
    console.log(`  \x1b[36m·\x1b[0m [dry-run] shell — would open ${mode} in ${plan.sessionName} at ${plan.cwd}`);
    return;
  }

  const action = useSplit ? await splitShell(plan) : await newShellWindow(plan);
  if (claudeLikeCaller) {
    console.log(`  \x1b[36m→\x1b[0m Claude-like caller detected — opened shell as background window to avoid smear (#1838).`);
  }
  console.log(`  \x1b[32m✓\x1b[0m ${action} — ${plan.sessionName}:${plan.windowName} (${plan.cwd})`);
}

async function splitShell(plan: AttachShellPlan): Promise<"split shell pane"> {
  await spawnProc(["tmux", "split-window", "-t", plan.targetWindow, "-h", "-l", "50%", plan.command]);
  return "split shell pane";
}

async function newShellWindow(plan: AttachShellPlan): Promise<"opened shell window"> {
  await spawnProc(["tmux", "new-window", "-t", `${plan.sessionName}:`, "-n", plan.windowName, plan.command]);
  return "opened shell window";
}

async function isClaudeLikeCaller(): Promise<boolean> {
  const pane = process.env.TMUX_PANE;
  if (!pane || process.env.MAW_ALLOW_CLAUDE_SPLIT === "1") return false;
  try {
    const proc = Bun.spawn(["tmux", "display-message", "-p", "-t", pane, "#{pane_current_command}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    return isClaudeLikePane(out.trim());
  } catch {
    return false;
  }
}

/**
 * Tmux attach takes over the terminal. Keep that handoff in-process so the
 * caller's stdio stays attached; spawning `maw tmux attach` can detach as soon
 * as the subprocess boundary exits (#1869).
 */
async function attachToSession(sessionName: string): Promise<void> {
  cmdTmuxAttach(sessionName);
}

/**
 * Invoke `maw` as a subprocess for wake paths that need the normal CLI
 * dispatch stack before this command can re-resolve and attach in-process.
 */
async function spawnMaw(args: string[]): Promise<void> {
  await spawnProc(["maw", ...args]);
}

async function spawnProc(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${exitCode}`);
  }
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "oracle";
}
