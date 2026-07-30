import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import { Tmux } from "../../../core/transport/tmux";
import { isAgentCommand } from "../../../core/agent-detect";
import { loadConfig } from "../../../config/load";
import * as mawSdk from "maw-js/sdk";
import { UserError } from "../../../core/util/user-error";
import { engineNamesForConfig } from "../../../config/engine-registry";
import type { MawConfig } from "../../../config/types";
import type { WakeOptions } from "../../../commands/shared/wake-cmd";
import type { TeamCharterEngines, TeamCharterMember } from "./team-charter";

export type TeamMemberState = "live" | "dead" | "missing" | "skipped";

export interface TeamPaneSnapshot {
  sessionName: string;
  windowName: string;
  command: string;
  path: string;
  paneId: string;
  panePid?: string;
  sessionId?: string;
  windowId?: string;
}

export interface TeamSessionSnapshot {
  name: string;
  windows: string[];
}

export interface ClassifiedTeamMember {
  member: TeamCharterMember;
  role: string;
  engine?: string;
  worktree: string;
  windowIdentity: string;
  state: TeamMemberState;
  pane?: TeamPaneSnapshot;
  skipReason?: string;
}

export interface WakeMemberDeps {
  cmdWakeFn?: (oracle: string, opts: WakeOptions) => Promise<string>;
}

export interface ClassifyMemberOptions {
  engine?: string;
  currentNode?: string;
  only?: Set<string>;
  members?: Set<string>;
  repoSlug?: string;
}

const SHELL_RE = /^-?(zsh|bash|sh|fish)$/i;

export function oracleStemFromRepoSlug(repoSlug: string): string {
  return (repoSlug.split("/").pop() || repoSlug).replace(/-oracle$/i, "");
}

export function memberWakeTarget(repoSlug: string, member: TeamCharterMember): string {
  if (member.worktree === false) return member.name?.trim() || oracleStemFromRepoSlug(repoSlug);
  return repoSlug;
}

export function memberWakeOptions(
  member: TeamCharterMember,
  opts: WakeOptions & { engine: string; session: string; repoPath: string },
): WakeOptions {
  const channels = opts.channels === undefined ? (member.channels === true) : opts.channels;
  const base: WakeOptions = {
    engine: opts.engine,
    session: opts.session,
    repoPath: opts.repoPath,
    ...(opts.engines ? { engines: opts.engines } : {}),
    ...(channels ? { channels: true } : {}),
  };
  if (member.worktree === false) return base;
  return { ...base, wt: memberWorktree(member) };
}

export function memberWindowIdentity(member: TeamCharterMember): string {
  return member.name?.trim() || member.role;
}

export function memberWorktree(member: TeamCharterMember): string {
  const identity = memberWindowIdentity(member);
  return typeof member.worktree === "string" && member.worktree.trim() ? member.worktree.trim() : identity;
}

export function memberEngine(member: TeamCharterMember, override?: string, config: MawConfig = loadConfig()): string {
  return override ?? member.engine ?? member.model ?? config.defaultEngine ?? mawSdk.defaultEngineNameForConfig(config);
}

/**
 * Classification is read-only liveness/identity work. It must not force a
 * launch-default lookup, because clean configs intentionally have no default
 * after #2797. Undefined means "launch default not resolved yet";
 * actual launch paths call memberEngine(..., config) and keep let-it-error.
 */
export function memberEngineForClassification(member: TeamCharterMember, override?: string): string | undefined {
  return override ?? member.engine ?? member.model;
}

export function isCodexLikeTeamEngine(engine: string, config: MawConfig = loadConfig()): boolean {
  try {
    const resolved = mawSdk.resolveEngine(engine, config) as { name?: string; cmd?: string; processNames?: string[] };
    const haystack = [engine, resolved.name, resolved.cmd, ...(resolved.processNames ?? [])]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return /(^|[\s/_-])(codex|omx)([\s/_-]|$)/i.test(haystack);
  } catch {
    return /^(codex|omx)$/i.test(engine);
  }
}

export function memberMatchesSelector(member: TeamCharterMember, selector: string): boolean {
  const wanted = selector.trim();
  if (!wanted) return false;
  return member.role === wanted || memberWindowIdentity(member) === wanted || memberWorktree(member) === wanted;
}

export function isOtherNodeMember(member: TeamCharterMember, currentNode?: string): boolean {
  return Boolean(member.node && member.node !== currentNode);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findRepoRoot(cwd = process.cwd()): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

export function resolveCharterPath(team: string, cwd = process.cwd(), configNode?: string): string | null {
  const root = findRepoRoot(cwd);
  const local = join(root, ".maw", "teams", `${team}.yaml`);
  if (existsSync(local)) return local;
  const psi = join(root, "ψ", "teams", `${team}.yaml`);
  if (existsSync(psi)) return psi;
  const nodeCandidate = configNode ? join(root, ".maw", `${configNode}.yaml`) : "";
  if (configNode && existsSync(nodeCandidate)) return nodeCandidate;
  return null;
}

export async function listPaneSnapshots(tmux: Pick<Tmux, "run"> = new Tmux()): Promise<TeamPaneSnapshot[]> {
  const raw = await tmux.run("list-panes", "-a", "-F", "#{session_name}|#{window_name}|#{pane_current_command}|#{pane_current_path}|#{pane_id}|#{pane_pid}|#{session_id}|#{window_id}");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sessionName = "", windowName = "", command = "", path = "", paneId = "", panePid = "", sessionId = "", windowId = ""] = line.split("|");
    return { sessionName, windowName, command, path, paneId, panePid, sessionId, windowId };
  });
}

export async function currentTmuxSession(tmux: Pick<Tmux, "run"> = new Tmux()): Promise<string> {
  return (await tmux.run("display-message", "-p", "#S")).trim();
}

export async function listSessionSnapshots(tmux: Pick<Tmux, "run"> = new Tmux()): Promise<TeamSessionSnapshot[]> {
  const raw = await tmux.run("list-windows", "-a", "-F", "#{session_name}|#{window_name}");
  const sessions = new Map<string, string[]>();
  for (const line of raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [name = "", window = ""] = line.split("|");
    if (!name) continue;
    const windows = sessions.get(name) ?? [];
    if (window) windows.push(window);
    sessions.set(name, windows);
  }
  return [...sessions.entries()].map(([name, windows]) => ({ name, windows }));
}

export function memberWindowCandidates(member: TeamCharterMember, repoSlug = ""): string[] {
  const identity = memberWindowIdentity(member);
  const candidates = [identity];
  if (member.worktree === false) {
    const stem = oracleStemFromRepoSlug(repoSlug || identity);
    candidates.push(stem, `${stem}-oracle`, identity.replace(/-oracle$/i, ""));
  } else {
    const worktree = memberWorktree(member);
    const sanitizedWorktree = mawSdk.sanitizeBranchName(worktree);
    if (sanitizedWorktree) {
      candidates.push(sanitizedWorktree);
      const stem = oracleStemFromRepoSlug(repoSlug);
      if (stem) candidates.push(`${stem}-${sanitizedWorktree}`);
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function classifyMember(
  member: TeamCharterMember,
  panes: TeamPaneSnapshot[],
  session: string,
  opts: ClassifyMemberOptions = {},
): ClassifiedTeamMember {
  const role = member.role;
  const windowIdentity = memberWindowIdentity(member);
  const engine = memberEngineForClassification(member, opts.engine);
  const worktree = memberWorktree(member);

  if (isOtherNodeMember(member, opts.currentNode)) {
    return { member, role, engine, worktree, windowIdentity, state: "skipped", skipReason: `other node: ${member.node}` };
  }
  if (opts.only && ![member.role, windowIdentity, worktree].some((value) => opts.only!.has(value))) {
    return { member, role, engine, worktree, windowIdentity, state: "skipped", skipReason: "outside --only" };
  }
  if (opts.members && !opts.members.has(member.role)) {
    return { member, role, engine, worktree, windowIdentity, state: "skipped", skipReason: "outside --members" };
  }

  const candidates = memberWindowCandidates(member, opts.repoSlug);
  const suffixes = candidates.map((candidate) => new RegExp(`-${escapeRegex(candidate)}$`));
  const pane = panes.find((candidate) =>
    candidate.sessionName === session && (candidates.includes(candidate.windowName) || suffixes.some((suffix) => suffix.test(candidate.windowName)))
  );
  if (!pane) return { member, role, engine, worktree, windowIdentity, state: "missing" };
  if (SHELL_RE.test(pane.command)) return { member, role, engine, worktree, windowIdentity, state: "dead", pane };
  if (isAgentCommand(pane.command)) return { member, role, engine, worktree, windowIdentity, state: "live", pane };
  return { member, role, engine, worktree, windowIdentity, state: "dead", pane };
}

export interface EngineCommandOptions {
  resume?: boolean;
  engines?: TeamCharterEngines;
}

function flattenEngineValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => flattenEngineValue(item));
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (value == null) return [];
  return [String(value).trim()].filter(Boolean);
}

export function resolveCharterEngineCommand(engine: string, engines?: TeamCharterEngines): string | undefined {
  const value = engines?.[engine];
  if (value === undefined) return undefined;
  const command = flattenEngineValue(value).join(" ").trim();
  return command || undefined;
}

export function knownTeamEngineNames(config: MawConfig, engines?: TeamCharterEngines): string[] {
  return [...new Set([
    ...engineNamesForConfig(config),
    ...Object.keys(engines ?? {}),
  ])].sort();
}

export function assertTeamEngineResolvable(engine: string, opts: EngineCommandOptions = {}, config: MawConfig = loadConfig()): void {
  const key = opts.resume ? `${engine}-resume` : engine;
  if (resolveCharterEngineCommand(key, opts.engines)) return;
  const known = new Set(knownTeamEngineNames(config, opts.engines));
  if (known.has(engine) || known.has(key)) return;
  const knownList = [...known].join(", ") || "none";
  throw new UserError(`engine '${engine}' not resolvable — known: [${knownList}]; define it in config.engines/config.commands or charter.engines`);
}

export function engineCommand(engine: string, opts: EngineCommandOptions = {}, config: MawConfig = loadConfig()): string {
  assertTeamEngineResolvable(engine, opts, config);
  const key = opts.resume ? `${engine}-resume` : engine;
  return resolveCharterEngineCommand(key, opts.engines) ?? mawSdk.resolveEngine(key, config).cmd;
}

export function repoSlugFromRoot(root: string): string {
  try {
    const proc = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
    const remote = new TextDecoder().decode(proc.stdout).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  } catch { /* best effort */ }
  const parts = root.split(/[\\/]+/);
  const githubIdx = parts.lastIndexOf("github.com");
  if (githubIdx !== -1 && parts[githubIdx + 1] && parts[githubIdx + 2]) {
    return `${parts[githubIdx + 1]}/${parts[githubIdx + 2]}`;
  }
  return basename(root);
}

export async function wakeMember(
  repoSlug: string,
  member: TeamCharterMember,
  opts: WakeOptions & { engine: string; session: string; repoPath: string },
  deps: WakeMemberDeps = {},
): Promise<string> {
  const wake = deps.cmdWakeFn ?? (await import("../../../commands/shared/wake-cmd")).cmdWake;
  return wake(memberWakeTarget(repoSlug, member), memberWakeOptions(member, opts));
}
