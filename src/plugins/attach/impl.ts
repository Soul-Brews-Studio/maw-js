/**
 * `maw attach <name>` cascade — Phase 1 (#25) — Smart Local.
 *
 *   Tier 1 (live):     attach immediately via the tmux attach implementation
 *   Tier 2 (sleeping): prompt → `maw wake <fleet-name>` → attach
 *   no match:          error + list of available oracles
 *
 * Cross-node attach has two paths:
 *   - explicit `maw attach <node>:<session>` (#1876)
 *   - implicit bounded federation precheck after local misses, before wake/scan (#1878)
 * Both hand off to attach-ssh.
 */
import { getGhqRoot, listSessions, loadFleetCore as loadFleet, UserError } from "maw-js/sdk";
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
  // #1911 — opt into oracle-window preference so multi-window sessions land
  // on the oracle's window deterministically instead of whichever was last-active.
  const result: ResolveResult = await resolveAttachTarget(name, deps, { federation: true, preferOracleWindow: true });

  if (!result) {
    // Local Tier 1+2 missed. Delegate to wake — it runs the full chain:
    // ghqFind → fleet pin → worktree → ghq get -u clone → GitHub org scan →
    // scanSuggestOracle interactive "Scan now? [y/N]" → wake.
    // After wake, re-resolve — should now be Tier 1 → attach.
    // See ψ/memory/traces/2026-05-13/1203_attach-find-or-scan-flow.md
    if (opts.dryRun) {
      const action = opts.shell ? "open shell" : "attach";
      console.log(`  \x1b[36m·\x1b[0m [dry-run] '${name}' not local or federated — would: maw wake ${name} → re-resolve → ${action}`);
      return;
    }
    console.log(`  \x1b[36m·\x1b[0m '${name}' not local or federated — delegating to wake`);
    await spawnMaw(["wake", name], { MAW_ATTACH_FOLLOWS: "1" });
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
    const retried = await resolveAttachTarget(name, deps, { fuzzy: true, preferOracleWindow: true });
    if (retried && retried.tier === 1) {
      if (opts.shell) {
        await openShellForSession(name, retried.sessionName, opts, deps.loadFleet());
        return;
      }
      const retriedTarget = retried.windowName ? `${retried.sessionName}:${retried.windowName}` : retried.sessionName;
      console.log(`  \x1b[32m→\x1b[0m attaching to ${retriedTarget}`);
      await attachToSession(retriedTarget);
      return;
    }
    console.error(`\x1b[31m✗\x1b[0m '${name}' still not running after wake`);
    throw new Error(`wake did not create a session for '${name}'`);
  }

  if (result.tier === "error") {
    console.error(`\x1b[31m✗\x1b[0m ${result.error}`);
    if (result.hint) console.error(`  ${result.hint}`);
    throw new UserError(result.error);
  }

  // Ambiguous match: list candidates, stop. User picks one and re-runs.
  if ("ambiguousCandidates" in result && result.ambiguousCandidates && result.ambiguousCandidates.length > 1) {
    console.error(`\x1b[33m⚠\x1b[0m '${name}' is ambiguous — ${result.ambiguousCandidates.length} matches:`);
    for (const c of result.ambiguousCandidates) console.error(`    • ${c}`);
    const hint = result.tier === 3 ? "maw attach <node>:<exact-name>" : "maw attach <exact-name>";
    console.error(`  use the full name: \x1b[36m${hint}\x1b[0m`);
    throw new Error(`ambiguous: ${name}`);
  }

  if (result.tier === 3) {
    if (opts.shell) {
      const message = "remote attach does not support --shell; use maw attach <node>:<session>";
      console.error(`\x1b[31m✗\x1b[0m ${message}`);
      throw new UserError(message);
    }
    if (opts.dryRun) {
      console.log(`  \x1b[36m·\x1b[0m [dry-run] Tier 3 (remote) — would attach to ${result.node}:${result.sessionName} via ssh ${result.sshAlias}`);
      return;
    }
    console.log(`  \x1b[32m→\x1b[0m attaching to ${result.node}:${result.sessionName} via ssh ${result.sshAlias}`);
    await executeRemoteAttach(result);
    return;
  }

  if (result.tier === 1) {
    if (opts.shell) {
      await openShellForSession(name, result.sessionName, opts, deps.loadFleet());
      return;
    }
    // #1911 — build session:window target when the resolver populated windowName
    // (opt-in via preferOracleWindow above). Bare sessionName falls through unchanged
    // for sessions without an oracle-named window.
    const tier1Target = result.windowName ? `${result.sessionName}:${result.windowName}` : result.sessionName;
    if (opts.dryRun) {
      console.log(`  \x1b[36m·\x1b[0m [dry-run] Tier 1 (live) — would attach to ${tier1Target}`);
      return;
    }
    console.log(`  \x1b[32m→\x1b[0m attaching to ${tier1Target}`);
    await attachToSession(tier1Target);
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
    await spawnMaw(["wake", result.fleetName], { MAW_ATTACH_FOLLOWS: "1" });
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

export interface AttachShellResolveDeps {
  /** Read a tmux session option; returns undefined when unset. Injected for testing. */
  readSessionOption?: (session: string, option: string) => string | undefined;
}

export function buildAttachShellPlan(
  requestedName: string,
  sessionName: string,
  fleet: FleetSessionLike[],
  deps: AttachShellResolveDeps = {},
): AttachShellPlan {
  const session = fleet.find(f => f.name === sessionName) ??
    fleet.find(f => sessionName.endsWith(`-${f.name}`));
  const window = session?.windows?.[0];
  let cwd: string;
  let windowBaseName: string;
  if (window?.repo) {
    cwd = join(getGhqRoot(), window.repo);
    windowBaseName = window.name || requestedName;
  } else {
    // #1916 MED-4 — workspace sessions (created via `maw new`) have no fleet
    // repo. Fall back to the @maw_new_cwd tmux option that `maw new` stamps
    // on the session, so `maw a <workspace> --shell` lands in the session's
    // real cwd instead of erroring.
    const workspaceCwd = deps.readSessionOption?.(sessionName, "@maw_new_cwd");
    if (workspaceCwd) {
      cwd = workspaceCwd;
      windowBaseName = window?.name || sessionName;
    } else {
      throw new Error(
        `cannot resolve repo path for '${requestedName}' in session '${sessionName}' — no oracle entry and no @maw_new_cwd set (try plain \`maw a ${requestedName}\` without --shell)`,
      );
    }
  }
  const targetWindow = `${sessionName}:${windowBaseName}`;
  const windowName = `${sanitizeTmuxName(windowBaseName || requestedName)}-shell`.slice(0, 80);
  const command = `cd ${shellArg(cwd)} && exec ${process.env.SHELL || "zsh"}`;
  return { sessionName, targetWindow, windowName, cwd, command };
}

async function openShellForSession(
  requestedName: string,
  sessionName: string,
  opts: AttachOpts,
  fleet: FleetSessionLike[],
): Promise<void> {
  // #1916 MED-4 — pass a real readSessionOption so workspace sessions
  // (no fleet entry) can fall back to their @maw_new_cwd.
  const { hostExec } = await import("maw-js/sdk");
  const readSessionOption = (session: string, option: string): string | undefined => {
    try {
      // hostExec is async but resolveSessionOptionSync isn't available; do a
      // best-effort sync wrap via execSync to keep buildAttachShellPlan sync.
      const { execSync } = require("child_process");
      const out = String(execSync(`tmux show-options -qv -t '${session}' ${option}`, { stdio: ["ignore", "pipe", "ignore"] })).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  void hostExec;
  const plan = buildAttachShellPlan(requestedName, sessionName, fleet, { readSessionOption });
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

async function executeRemoteAttach(target: Extract<ResolveResult, { tier: 3 }>): Promise<void> {
  const attachSsh = await import("../attach-ssh/index");
  await attachSsh.default.execute(target);
}

/**
 * Invoke `maw` as a subprocess for wake paths that need the normal CLI
 * dispatch stack before this command can re-resolve and attach in-process.
 */
type SpawnEnv = Record<string, string>;

async function spawnMaw(args: string[], extraEnv: SpawnEnv = {}): Promise<void> {
  await spawnProc(["maw", ...args], extraEnv);
}

async function spawnProc(cmd: string[], extraEnv: SpawnEnv = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...extraEnv },
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
