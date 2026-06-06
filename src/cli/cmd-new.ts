/**
 * `maw new` — shared workspace tmux session factory (#1616).
 *
 * Creates a named tmux session with a plain shell workspace window. It does not
 * create, wake, bud, or awaken an oracle. Use it as the first step in a shared
 * workspace:
 *
 *   maw new my-project
 *   maw team oracle-invite volt odin --team my-project
 *   maw team bring my-project
 */

import { homedir } from "os";
import { stat } from "fs/promises";
import { basename, resolve } from "path";
import { parseFlags } from "./parse-args";
import { buildCommandInDir } from "../config";
import { UserError } from "../core/util/user-error";
import { tmux } from "../sdk";
import { attachToSession } from "../commands/shared/wake-session";
import { ensureFleetSessionEntry } from "../commands/shared/fleet-ensure";
import { prefixCommandWithSpawnSessionEnv } from "../core/fleet/parent-session";

/** Truthy env values: "1", "true", "yes", "on" (case-insensitive). */
export function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

export interface NewWorkspaceAttachOpts {
  attach: boolean;
  noAttach: boolean;
  envNoPrompt: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export type NewWorkspaceAttachDecision =
  | { action: "attach"; reason: "attach-flag" | "interactive-tty" }
  | { action: "skip"; reason: "no-attach-flag" | "env-no-prompt" | "non-tty" };

/**
 * Pure attach/switch decision for `maw new`.
 *
 * Defaults are intentionally ergonomic but automation-safe:
 * - `--no-attach` and `MAW_NO_PROMPT=1` always print-only.
 * - `--attach` forces attach/switch.
 * - interactive shells attach/switch by default.
 * - non-TTY scripts print instructions instead of blocking on tmux attach.
 */
export function decideNewWorkspaceAttach(opts: NewWorkspaceAttachOpts): NewWorkspaceAttachDecision {
  if (opts.noAttach) return { action: "skip", reason: "no-attach-flag" };
  if (opts.envNoPrompt) return { action: "skip", reason: "env-no-prompt" };
  if (opts.attach) return { action: "attach", reason: "attach-flag" };
  if (opts.stdinIsTTY && opts.stdoutIsTTY) return { action: "attach", reason: "interactive-tty" };
  return { action: "skip", reason: "non-tty" };
}

export function validateWorkspaceSessionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new UserError(
      `new: invalid session name '${name}' — use letters, numbers, dot, underscore, or dash`,
    );
  }
  if (name.endsWith("-view")) {
    throw new UserError("new: session names ending in '-view' are reserved for maw view");
  }
}

export function validateWorkspaceWindowName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new UserError(
      `new: invalid window name '${name}' — use letters, numbers, dot, underscore, or dash`,
    );
  }
}

function printUsage(write: (line: string) => void = console.log): void {
  write("usage: maw new [session-name] [--path|-p <dir>] [--window <name>] [--cmd|-c <cmd>|--claude] [--shell] [--split [--right|--horizontal|--bottom|--vertical]] [--print|--json] [--attach|-a] [--no-attach] [--dry-run]");
  write("  Create a plain tmux workspace session with a shell window.");
  write("  --path, -p   Start the workspace shell in <dir> (absolute, relative, or ~/...)");
  write("  --window     Name the first tmux window (default: lead).");
  write("  --cmd, -c    Run <cmd> after the shell starts; keep the shell open afterward.");
  write("  --shell      Explicit shell mode (default today; accepted for future symmetry).");
  write("  --claude     Shortcut for Claude Code with maw team env enabled.");
  write("  --split      Open as a full-window split in the current tmux window instead of a new session.");
  write("  --right, --horizontal  With --split, create a full-height pane at the right edge (tmux -f -h).");
  write("  --bottom, --vertical   With --split, create a full-width pane at the bottom edge (tmux -f -v; default).");
  write("  --print      Print a JSON payload with session/window/pane_id for scripts.");
  write("  --json       Alias for --print.");
  write("  --dry-run    Show what WOULD happen without creating any tmux state. (#1913)");
  write("  --no-fleet   Do not auto-register the created session in the fleet registry.");
  write("  --parent-session-id <id>  Set MAW_PARENT_SESSION_ID for spawned Claude commands (#1925).");
  write("  --session-id <id>         Set deterministic MAW_SESSION_ID for spawned Claude commands (#1925).");
  write("  Then bring oracles in with: maw team bring <team> [--session <session>]");
  write("  Oracle creation remains: maw awaken <name> (or maw bud <name>).");
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

async function resolveWorkspacePath(rawPath: unknown): Promise<string> {
  if (rawPath === undefined) return process.cwd();
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new UserError("new: --path requires a non-empty directory");
  }
  const cwd = resolve(process.cwd(), expandHomePath(rawPath));
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new UserError(`new: path does not exist: ${rawPath}`);
  }
  if (!info.isDirectory()) {
    throw new UserError(`new: path is not a directory: ${rawPath}`);
  }
  return cwd;
}

function normalizeStartupCommand(rawCmd: unknown): string | undefined {
  if (rawCmd === undefined) return undefined;
  if (typeof rawCmd !== "string" || rawCmd.trim() === "") {
    throw new UserError("new: --cmd cannot be empty");
  }
  return rawCmd;
}

function slugSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function truncateWorkspaceName(input: string): string {
  return input.slice(0, 80).replace(/[-_.]+$/g, "") || "workspace";
}

function autoWorkspaceSessionName(cwd: string, startupCommand: string | undefined, usedPathFlag: boolean): string | undefined {
  const parts: string[] = [];
  if (usedPathFlag) parts.push(slugSegment(basename(cwd)));
  if (startupCommand) parts.push(slugSegment(startupCommand));
  const raw = parts.filter(Boolean).join("-");
  return raw ? truncateWorkspaceName(raw) : undefined;
}

function looksLikeClaudeCommand(command: string): boolean {
  return /(^|[\s/])claude(?:\.exe)?(?:\s|$)/.test(command);
}

function withClaudeTeamEnv(command: string): string {
  return `env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 ${command}`;
}

function buildClaudeStartupCommand(name: string, cwd: string): string {
  const configured = buildCommandInDir(name, cwd, "claude");
  const command = looksLikeClaudeCommand(configured) ? configured : "claude";
  return withClaudeTeamEnv(command);
}

function shellAfterCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return `${command}; exec ${process.env.SHELL || "zsh"}`;
}

type NewWorkspacePrintPayload = {
  session: string;
  window: string;
  pane_id?: string;
  cwd: string;
  command?: string;
  reused: boolean;
  dry_run?: boolean;
};

type SplitDirection = "horizontal" | "vertical";

function splitDirectionFromFlags(flags: Record<string, unknown>): SplitDirection | undefined {
  const wantsHorizontal = !!(flags["--right"] || flags["--horizontal"]);
  const wantsVertical = !!(flags["--bottom"] || flags["--vertical"]);
  if (wantsHorizontal && wantsVertical) {
    throw new UserError("new: choose only one split direction (--right/--horizontal or --bottom/--vertical)");
  }
  if (wantsHorizontal) return "horizontal";
  if (wantsVertical) return "vertical";
  return undefined;
}

async function workspacePaneId(session: string, windowName: string): Promise<string | undefined> {
  return tmux.firstPaneId?.(`${session}:${windowName}`) ?? undefined;
}

async function currentTmuxSessionWindow(): Promise<{ session: string; window: string }> {
  let raw: string;
  try {
    raw = await tmux.run("display-message", "-p", "#{session_name}\t#{window_name}");
  } catch {
    throw new UserError("new: --split requires a current tmux client");
  }
  const [session, window] = raw.trim().split("\t");
  if (!session || !window) throw new UserError("new: --split could not resolve the current tmux window");
  return { session, window };
}

const WORKSPACE_CWD_OPTION = "@maw_new_cwd";
const WORKSPACE_COMMAND_OPTION = "@maw_new_command";
const WORKSPACE_WINDOW_OPTION = "@maw_new_window";

async function readSessionOption(session: string, option: string): Promise<string | undefined> {
  try {
    return (await tmux.run("show-options", "-qv", "-t", session, option)).trim();
  } catch {
    return undefined;
  }
}

async function readWorkspaceLaunch(session: string): Promise<{ cwd: string; command: string; window: string } | undefined> {
  const cwd = await readSessionOption(session, WORKSPACE_CWD_OPTION);
  if (cwd === undefined) return undefined;
  const command = await readSessionOption(session, WORKSPACE_COMMAND_OPTION);
  const window = await readSessionOption(session, WORKSPACE_WINDOW_OPTION);
  return { cwd, command: command ?? "", window: window || "lead" };
}

async function rememberWorkspaceLaunch(session: string, cwd: string, command: string | undefined, windowName: string): Promise<void> {
  await tmux.setOption(session, WORKSPACE_CWD_OPTION, cwd);
  await tmux.setOption(session, WORKSPACE_COMMAND_OPTION, command ?? "");
  await tmux.setOption(session, WORKSPACE_WINDOW_OPTION, windowName);
}

function printMachinePayload(payload: NewWorkspacePrintPayload): void {
  console.log(JSON.stringify(payload));
}

/** Implementation of `maw new <name>` as a workspace/session factory. */
export async function cmdNew(argv: string[]): Promise<void> {
  const flags = parseFlags(argv, {
    "--attach": Boolean,
    "-a": "--attach",
    "--no-attach": Boolean,
    "--path": String,
    "-p": "--path",
    "--window": String,
    "--cmd": String,
    "-c": "--cmd",
    "--shell": Boolean,
    "--claude": Boolean,
    "--split": Boolean,
    "--right": Boolean,
    "--horizontal": Boolean,
    "--bottom": Boolean,
    "--vertical": Boolean,
    "--print": Boolean,
    "--json": Boolean,
    "--dry-run": Boolean,
    "--no-fleet": Boolean,
    "--parent": String,
    "--parent-session-id": String,
    "--session-id": String,
  }, 0);

  const explicitName = (flags._ as string[])[0];
  if (explicitName === "--help" || explicitName === "-h") {
    printUsage(console.error);
    throw new UserError("new: missing session name");
  }
  if (explicitName?.startsWith("-")) {
    printUsage(console.error);
    throw new UserError(`new: invalid session name '${explicitName}'`);
  }

  const cwd = await resolveWorkspacePath(flags["--path"]);
  if (flags["--claude"] && flags["--cmd"] !== undefined) {
    throw new UserError("new: use either --claude or --cmd, not both");
  }
  const commandNameHint = explicitName ?? (slugSegment(basename(cwd)) || "workspace");
  const startupCommand = flags["--claude"]
    ? prefixCommandWithSpawnSessionEnv(buildClaudeStartupCommand(commandNameHint, cwd), {
        explicit: (flags["--parent-session-id"] as string | undefined) || (flags["--parent"] as string | undefined),
        sessionId: flags["--session-id"] as string | undefined,
        cwd,
      })
    : normalizeStartupCommand(flags["--cmd"]);
  const autoNameCommand = flags["--claude"] ? "claude" : startupCommand;
  let name = explicitName ?? autoWorkspaceSessionName(cwd, autoNameCommand, flags["--path"] !== undefined);
  if (!name) {
    printUsage(console.error);
    throw new UserError("new: missing session name");
  }
  validateWorkspaceSessionName(name);
  const rawWindowName = flags["--window"];
  if (rawWindowName !== undefined && (typeof rawWindowName !== "string" || rawWindowName.trim() === "")) {
    throw new UserError("new: --window requires a non-empty name");
  }
  const windowName = rawWindowName ?? "lead";
  validateWorkspaceWindowName(windowName);
  const tmuxCommand = shellAfterCommand(startupCommand);

  // #1894 — when name was auto-derived AND it collides with an existing
  // session whose launch context differs, auto-suffix (-2, -3, ...) to find
  // a free slot instead of silently failing or surprising the caller with a
  // foreign session reuse. Only applies when the user did NOT pass an
  // explicit name — explicit names keep the fail-loud behaviour at line
  // 326 below (intentional: explicit name means "this exact session").
  if (!explicitName) {
    const baseName = name;
    for (let suffix = 1; suffix <= 99; suffix++) {
      const candidate = suffix === 1 ? baseName : `${baseName}-${suffix}`;
      if (!(await tmux.hasSession(candidate))) { name = candidate; break; }
      const existingLaunch = await readWorkspaceLaunch(candidate);
      const contextMatches = !!existingLaunch
        && existingLaunch.cwd === cwd
        && existingLaunch.command === (startupCommand ?? "")
        && (rawWindowName === undefined || existingLaunch.window === windowName);
      if (contextMatches) { name = candidate; break; }
      if (suffix === 99) {
        throw new UserError(`new: 99 collisions for '${baseName}-N' — pass explicit session name`);
      }
    }
    if (name !== baseName && !(flags["--print"] || flags["--json"])) {
      console.log(`  \x1b[33m⚠\x1b[0m '${baseName}' exists with different context; using '${name}'`);
    }
  }

  const machineReadable = !!(flags["--print"] || flags["--json"]);
  const dryRun = !!flags["--dry-run"];
  const split = !!flags["--split"];
  const splitDirection = splitDirectionFromFlags(flags as Record<string, unknown>);
  if (!split && splitDirection !== undefined) {
    throw new UserError("new: split direction flags require --split");
  }
  if (split && rawWindowName !== undefined) {
    throw new UserError("new: --window only applies when creating or reusing a workspace session, not --split");
  }

  if (split) {
    const { session, window } = await currentTmuxSessionWindow();
    let paneId: string | undefined;
    if (!dryRun) {
      const rawPaneId = await tmux.splitWindow(undefined, {
        cwd,
        direction: splitDirection ?? "vertical",
        fullWindow: true,
        ...(tmuxCommand ? { command: tmuxCommand } : {}),
        printFormat: "#{pane_id}",
      });
      paneId = rawPaneId?.trim() || undefined;
      if (paneId) await tmux.selectPane(paneId, { title: name });
    }

    if (machineReadable) {
      printMachinePayload({
        session,
        window,
        ...(paneId ? { pane_id: paneId } : {}),
        cwd,
        ...(startupCommand ? { command: startupCommand } : {}),
        reused: false,
        ...(dryRun ? { dry_run: true } : {}),
      });
    } else {
      const mode = startupCommand ? "split shell + command" : "split shell";
      const verb = dryRun ? `\x1b[36m·\x1b[0m [dry-run] would create` : `\x1b[32m✓\x1b[0m created`;
      const edge = (splitDirection ?? "vertical") === "horizontal" ? "right edge" : "bottom edge";
      console.log(`${verb} ${mode} '${name}' at ${edge} in ${session}:${window}`);
    }
    if (dryRun && !machineReadable) {
      console.log(`  \x1b[90mno tmux state changed (dry-run). Drop --dry-run to actually create.\x1b[0m`);
    }
    return;
  }

  const existed = await tmux.hasSession(name);
  let paneId: string | undefined;
  let payloadWindowName = windowName;
  if (!existed) {
    if (!dryRun) {
      const rawPaneId = await tmux.newSession(name, {
        window: windowName,
        cwd,
        ...(tmuxCommand ? { command: tmuxCommand } : {}),
        ...(machineReadable ? { printFormat: "#{pane_id}" } : {}),
      });
      paneId = rawPaneId?.trim() || undefined;
      await rememberWorkspaceLaunch(name, cwd, startupCommand, windowName);
      if (!flags["--no-fleet"]) {
        const fleet = ensureFleetSessionEntry({ session: name, window: windowName, cwd, createdBy: "maw new" });
        if (fleet.status === "created" && !machineReadable) {
          console.log(`\x1b[32m+\x1b[0m fleet auto-registered ${name}`);
        }
      }
    }
    if (!machineReadable) {
      const mode = startupCommand ? `${windowName} shell + command` : `${windowName} shell`;
      const verb = dryRun ? `\x1b[36m·\x1b[0m [dry-run] would create` : `\x1b[32m✓\x1b[0m created`;
      console.log(`${verb} workspace session '${name}' (${mode})`);
    }
  } else {
    const existingLaunch = await readWorkspaceLaunch(name);
    const effectiveWindowName = existingLaunch?.window ?? windowName;
    payloadWindowName = effectiveWindowName;
    if (existingLaunch && (
      existingLaunch.cwd !== cwd
      || existingLaunch.command !== (startupCommand ?? "")
      || (rawWindowName !== undefined && existingLaunch.window !== windowName)
    )) {
      throw new UserError(
        `new: session '${name}' already exists with different launch context; choose a new name or match the original --path/--cmd/--window`,
      );
    }
    paneId = machineReadable ? await workspacePaneId(name, effectiveWindowName) : undefined;
    if (!machineReadable) {
      const prefix = dryRun ? `\x1b[36m·\x1b[0m [dry-run] would reuse` : `\x1b[36m→\x1b[0m session exists:`;
      console.log(`${prefix} ${name}`);
    }
  }

  if (machineReadable) {
    printMachinePayload({
      session: name,
      window: payloadWindowName,
      ...(paneId ? { pane_id: paneId } : {}),
      cwd,
      ...(startupCommand ? { command: startupCommand } : {}),
      reused: existed,
      ...(dryRun ? { dry_run: true } : {}),
    });
  }

  if (dryRun) {
    if (!machineReadable) {
      console.log(`  \x1b[90mno tmux state changed (dry-run). Drop --dry-run to actually create.\x1b[0m`);
    }
    return;
  }

  const decision = decideNewWorkspaceAttach({
    attach: !!flags["--attach"],
    noAttach: !!flags["--no-attach"],
    envNoPrompt: isTruthyEnv(process.env.MAW_NO_PROMPT),
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
  });

  if (decision.action === "attach") {
    await attachToSession(name);
    return;
  }

  if (!machineReadable) {
    console.log(`\x1b[36mRun:\x1b[0m maw a ${name}`);
    console.log(`\x1b[90m  next: maw team bring ${name}\x1b[0m`);
  }
}
