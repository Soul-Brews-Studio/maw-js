import { hostExec, tmux, restoreTabOrder, takeSnapshot, getPaneInfos, isAgentCommand } from "../../sdk";
import { resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ghqFind } from "../../core/ghq";
import { buildCommandInDir, cfgTimeout, loadConfig, saveConfig } from "../../config";
import { defaultEngineNameForConfig } from "../../config/engine-registry";
import { resolveWorktreeTarget } from "../../core/matcher/resolve-target";
import { normalizeWorktreeLayout, type WorktreeLayout } from "../../core/fleet/worktree-layout";
import { prefixCommandWithSpawnSessionEnv } from "../../core/fleet/parent-session";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { assertValidOracleName } from "../../core/fleet/validate";
import { canonicalSessionName } from "../../core/fleet/session-name";
import { resolveOracle, findWorktrees, findReusableWorktreeBySlug, getSessionMap, resolveFleetSession, detectSession, setSessionEnv, sanitizeBranchName } from "./wake-resolve";
import { stripOracleRepoSuffix, bringCwdMetadata, deriveOracleFromCwd } from "./wake-cwd";
// #2569 — re-export so the wake barrel surface still exposes deriveOracleFromCwd.
export { deriveOracleFromCwd } from "./wake-cwd";
import * as wakeSession from "./wake-session";
import { maybeOpenWindow, maybeSplit } from "./wake-maybe-split";
import { runWakeLifecycleHooks } from "../../plugin/lifecycle";
import { ensureFleetSessionEntry } from "./fleet-ensure";
import { isClaudeLikeEngine } from "../../core/engine/is-claude-like";
import { parseWakeTarget, ensureCloned } from "./wake-target";
import { assertAgentCapacity } from "./wake-concurrency";
import {
  listSnapshots,
  latestSnapshot,
  loadSnapshot,
  type Snapshot,
  type SnapshotSession,
} from "../../core/fleet/snapshot";
import type { FleetSession } from "./fleet-load";
import { listClaudeSessions, type ClaudeSession } from "../../core/fleet/claude-sessions";
import { UserError } from "../../core/util/user-error";
import {
  type RehydrateWorktreePlan,
  type SnapshotRestorePlan,
  filterMergedWorktreesForRehydrate,
  findWakeSnapshotSession,
  planRehydrateWorktreeWindows,
  planSnapshotRestoreWindows,
  retryFreshSessionTmuxStep,
  shouldOfferExistingSessionAttach,
  shouldRehydrateWorktrees,
  writeWakeBudBirthSignal,
  writeWakeBudLineage,
} from "./wake-cmd-helpers";
import { drainWakeInbox, mergeWakeInboxPrompt } from "./wake-inbox-drain";
export {
  type RehydrateWorktreePlan,
  type SnapshotRestorePlan,
  type WakeBudLineageInput,
  buildWakeBudLineage,
  filterMergedWorktreesForRehydrate,
  findWakeSnapshotSession,
  planRehydrateWorktreeWindows,
  planSnapshotRestoreWindows,
  retryFreshSessionTmuxStep,
  shouldOfferExistingSessionAttach,
  waitForTmuxSessionReady,
  writeWakeBudBirthSignal,
  writeWakeBudLineage,
} from "./wake-cmd-helpers";

/**
 * Worktree picker hooks for #1768. Wrapped in an object so tests can mock
 * both the TTY check and the keystroke read — matches the `_tty` pattern in
 * src/commands/plugins/tmux/impl.ts. Kept local to wake-cmd to keep this
 * change self-contained.
 *
 * @internal — exported for tests.
 */
export const _wtPicker = {
  isStdoutTTY: (): boolean => {
    try {
      const { isatty } = require("node:tty") as typeof import("node:tty");
      return isatty(1);
    } catch {
      return !!process.stdout.isTTY;
    }
  },
  readChoice: (): string | null => {
    try {
      const { openSync, readSync, closeSync } = require("fs") as typeof import("fs");
      const fd = openSync("/dev/tty", "r");
      const buf = Buffer.alloc(8);
      const n = readSync(fd, buf, 0, buf.length, null);
      closeSync(fd);
      return buf.slice(0, n).toString().trim();
    } catch { return null; }
  },
};

async function respawnPaneWithCommand(target: string, command: string): Promise<boolean> {
  const runner = (tmux as unknown as { run?: (subcommand: string, ...args: Array<string | number>) => Promise<string> }).run;
  if (typeof runner !== "function") return false;
  await runner.call(tmux, "respawn-pane", "-k", "-t", target, command);
  return true;
}

/**
 * Show a numbered picker when `--wt <host>` matches multiple existing
 * worktrees (#1768). Returns the picked candidate, or null if the choice is
 * invalid / not made — caller falls back to the loud error so scripted
 * callers still fail fast.
 *
 * @internal — exported for tests.
 */
export function promptAmbiguousWorktreePick<T extends { name: string; path: string }>(
  host: string,
  candidates: T[],
): T | null {
  if (!_wtPicker.isStdoutTTY()) return null;
  console.log("");
  console.log(`  '${host}' matches ${candidates.length} worktrees — wake which?`);
  for (let i = 0; i < candidates.length; i++) {
    console.log(`  \x1b[36m${i + 1}\x1b[0m) ${candidates[i]!.name}  \x1b[90m${candidates[i]!.path}\x1b[0m`);
  }
  console.log("");
  process.stdout.write(`  Select [1-${candidates.length}]: `);
  const raw = _wtPicker.readChoice();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const choice = Number(raw);
  if (!Number.isFinite(choice) || choice < 1 || choice > candidates.length) return null;
  return candidates[choice - 1]!;
}


type BringWindowCandidate = {
  name: string;
  target: string;
  detail: string;
};

type LiveWindowMatch = {
  session: string;
  window: string;
  target: string;
};

type BringWindowLookupCandidate = BringWindowCandidate & {
  aliases: string[];
};

// #2569 — cwd → oracle/worktree derivation lives in ./wake-cwd (deps-free so it
// is unit-testable without the sdk/config mock cascade).

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

async function buildBringWindowCandidates(
  session: string,
  windows: { name: string; cwd?: string }[],
): Promise<BringWindowLookupCandidate[]> {
  const targets = windows.map(w => `${session}:${w.name}`);
  const infos = await getPaneInfos(targets);
  return windows.map((w) => {
    const target = `${session}:${w.name}`;
    const metadata = bringCwdMetadata(w.cwd ?? infos[target]?.cwd);
    const aliases = [w.name];
    const detail = [`tmux window in ${session}`];
    if (metadata.oracle) {
      aliases.push(metadata.oracle, `${metadata.oracle}-oracle`);
      detail.push(`oracle ${metadata.oracle}`);
    }
    if (metadata.worktree) {
      aliases.push(metadata.worktree);
      detail.push(`worktree ${metadata.worktree}`);
    }
    return {
      name: w.name,
      target,
      detail: detail.join(" · "),
      aliases: uniqueNonEmpty(aliases),
    };
  });
}

function resolveBringWindowCandidates(
  targetName: string,
  candidates: BringWindowLookupCandidate[],
): BringWindowCandidate[] {
  const lc = targetName.trim().toLowerCase();
  const levels = [
    (name: string) => name === lc,
    (name: string) => name.endsWith(`-${lc}`),
    (name: string) => name.startsWith(`${lc}-`) || name.includes(`-${lc}-`),
  ];
  for (const match of levels) {
    const matches = candidates.filter(candidate =>
      candidate.aliases.some(alias => match(alias.toLowerCase())),
    );
    if (matches.length > 0) {
      const seen = new Set<string>();
      return matches.filter((candidate) => {
        if (seen.has(candidate.target)) return false;
        seen.add(candidate.target);
        return true;
      });
    }
  }
  return [];
}

/**
 * Show a numbered picker for `maw bring <target> --pick` when the target
 * fuzzily matches live tmux windows, oracle names, or worktree names in the
 * destination session (#1816).
 * Reuses the wake picker TTY hooks so headless/scripted callers fail loudly
 * instead of silently choosing the legacy fuzzy oracle fallback.
 *
 * @internal — exported for tests.
 */
export function promptAmbiguousBringPick(
  targetName: string,
  candidates: BringWindowCandidate[],
): BringWindowCandidate | null {
  if (!_wtPicker.isStdoutTTY()) return null;
  if (candidates.length === 0) return null;
  console.log("");
  console.log(`  '${targetName}' is ambiguous — bring which?`);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    console.log(`  \x1b[36m${i + 1}\x1b[0m) ${candidate.name}  \x1b[90m${candidate.detail}\x1b[0m`);
  }
  console.log("  \x1b[90mq) quit\x1b[0m");
  console.log("");
  process.stdout.write(`  Select [1-${candidates.length}]: `);
  const raw = _wtPicker.readChoice()?.trim().toLowerCase();
  if (!raw || raw === "q" || raw === "quit") return null;
  if (!/^\d+$/.test(raw)) return null;
  const choice = Number(raw);
  if (!Number.isFinite(choice) || choice < 1 || choice > candidates.length) return null;
  return candidates[choice - 1]!;
}

type WorktreeSessionSummary = {
  lastActivityAt: string;
  messageCount: number;
  status: ClaudeSession["status"];
};

function relativeAge(timestamp: string, now = Date.now()): string {
  const ageMs = now - Date.parse(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0) return timestamp;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function worktreeSessionSummaries(
  worktrees: { name: string; path: string }[],
): Promise<Map<string, WorktreeSessionSummary>> {
  const summaries = new Map<string, WorktreeSessionSummary>();
  let sessions: ClaudeSession[] = [];
  try {
    sessions = await listClaudeSessions();
  } catch {
    return summaries;
  }
  const wanted = new Map(worktrees.map(w => [resolve(w.path), w.name]));
  const statusRank = { active: 0, idle: 1, ended: 2 } as const;
  for (const session of sessions) {
    const name = wanted.get(resolve(session.projectPath));
    if (!name) continue;
    const previous = summaries.get(name);
    const nextTime = Date.parse(session.lastActivityAt);
    const prevTime = previous ? Date.parse(previous.lastActivityAt) : Number.NEGATIVE_INFINITY;
    summaries.set(name, {
      lastActivityAt: nextTime >= prevTime ? session.lastActivityAt : previous!.lastActivityAt,
      messageCount: (previous?.messageCount ?? 0) + session.messageCount,
      status: previous
        ? (statusRank[session.status] < statusRank[previous.status] ? session.status : previous.status)
        : session.status,
    });
  }
  return summaries;
}

function formatWorktreeSessionSummary(summary: WorktreeSessionSummary | undefined): string {
  if (!summary) return "";
  const messages = summary.messageCount === 1 ? "1 msg" : `${summary.messageCount} msgs`;
  return `  \x1b[90m${summary.status} · ${messages} · last ${relativeAge(summary.lastActivityAt)}\x1b[0m`;
}

async function recordWakeSnapshot(opts: Pick<WakeOptions, "snapshotRetention"> = {}): Promise<void> {
  try {
    await takeSnapshot("wake", opts.snapshotRetention);
  } catch {
    // Snapshotting is recovery metadata. A transient tmux/config read failure
    // must not turn an otherwise-successful wake into a failed wake.
  }
}

export async function getLiveTileRoles(
  session: string,
  deps: { hostExecFn?: typeof hostExec } = {},
): Promise<Set<string>> {
  const run = deps.hostExecFn ?? hostExec;
  try {
    const raw = await run(`tmux list-panes -t '${session}' -F '#{@maw_tile_role}'`);
    return new Set(
      raw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set<string>();
  }
}


export type WakeSessionMode = "oracle" | "work";

export class WakeSession {
  readonly mode: WakeSessionMode;

  constructor(mode: WakeSessionMode) {
    this.mode = mode;
    Object.freeze(this);
  }
}

function repoNameFromPath(repoPath: string): string {
  return repoPath.split("/").filter(Boolean).pop() ?? repoPath;
}

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}

function repoNameFromTarget(target: string, urlRepoName?: string): string {
  if (urlRepoName?.trim()) return stripGitSuffix(urlRepoName.trim());
  const cleaned = stripGitSuffix(target.trim().replace(/\/+$/, ""));
  return cleaned.split("/").filter(Boolean).pop() ?? cleaned;
}

function detectWakeSessionMode(target: string, opts: Pick<WakeOptions, "sessionMode" | "urlRepoName" | "repoPath">): WakeSession {
  if (opts.sessionMode) return new WakeSession(opts.sessionMode);
  if (/^\d+-/.test(target.trim())) return new WakeSession("oracle");
  const repoName = opts.repoPath ? repoNameFromPath(opts.repoPath) : repoNameFromTarget(target, opts.urlRepoName);
  if (repoName.toLowerCase().endsWith("-oracle")) return new WakeSession("oracle");
  return new WakeSession(opts.repoPath || opts.urlRepoName ? "work" : "oracle");
}

function identityForWakeSession(session: WakeSession, repoName: string, currentIdentity: string): string {
  if (session.mode === "work") return repoName;
  return repoName.toLowerCase().endsWith("-oracle") ? repoName.replace(/-oracle$/i, "") : currentIdentity;
}

function mainWindowNameForWakeSession(session: WakeSession, identity: string): string {
  return session.mode === "oracle" ? `${identity}-oracle` : identity;
}

async function resolveWorkRepository(target: string, parsedRepoPath: string | null, opts: Pick<WakeOptions, "repoPath" | "urlRepoName">): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  if (opts.repoPath) {
    const repoPath = opts.repoPath;
    return { repoPath, repoName: repoNameFromPath(repoPath), parentDir: repoPath.replace(/\/[^/]+$/, "") };
  }
  if (parsedRepoPath) {
    const repoPath = parsedRepoPath;
    return { repoPath, repoName: repoNameFromPath(repoPath), parentDir: repoPath.replace(/\/[^/]+$/, "") };
  }

  const repoName = repoNameFromTarget(target, opts.urlRepoName);
  const repoPath = await ghqFind(`/${repoName}`);
  if (repoPath) {
    return { repoPath, repoName: repoNameFromPath(repoPath), parentDir: repoPath.replace(/\/[^/]+$/, "") };
  }

  throw new UserError(`work repo not found: ${repoName} (try: ghq get <url> OR maw wake ${target} --oracle for oracle mode)`);
}

function ensureWakeSessionVault(session: WakeSession, repoPath: string): void {
  if (session.mode !== "work") return;
  const psiDir = join(repoPath, "ψ");
  mkdirSync(psiDir, { recursive: true });

  const gitignorePath = join(repoPath, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = existing.split(/\r?\n/);
  if (lines.some(line => line.trim() === "ψ/" || line.trim() === "ψ")) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, `${existing}${prefix}ψ/\n`, "utf-8");
}

export interface WakeOptions {
  task?: string;
  wt?: string;
  prompt?: string;
  /** Target an existing foreign tmux workspace session instead of the oracle's own session (#1616). */
  session?: string;
  incubate?: string;
  fresh?: boolean;
  pick?: boolean;
  /** Stable reusable worktree name used with --wt/--task (#1768). */
  name?: string;
  attach?: boolean;
  listWt?: boolean;
  dryRun?: boolean;
  noRehydrate?: boolean;
  /**
   * Opt IN to per-worktree rehydration (default OFF; thread #14, owner GO
   * 2026-06-11). Without this (and without the `respawnWorktrees` config key),
   * a plain `maw wake <role>` touches only the role window and does NOT spawn a
   * `<role>-<wt-suffix>` window per worktree on disk. See shouldRehydrateWorktrees.
   */
  respawnWorktrees?: boolean;
  noFleet?: boolean;
  split?: boolean;
  /** Hidden bring alias split anchor. Shape: "session:window" (#1816 Part 3). */
  splitTarget?: string;
  /** Hidden marker set by `maw bring` so wake can prefer live tmux windows (#1816 Part 4). */
  bringAlias?: boolean;
  /** Internal marker: `maw bring --to <window>` was resolved to session:window (#1824). */
  resolvedBringDestinationWindow?: LiveWindowMatch;
  bring?: boolean;
  tab?: boolean;
  bud?: boolean;
  signalOnBirth?: boolean;
  repoPath?: string;
  urlRepoName?: string;
  allLocal?: boolean;
  engine?: string;
  /** Parent session to expose to newly spawned agents (#1925). */
  parentSessionId?: string;
  /** Fleet snapshot retention override for this wake invocation (#2146). */
  snapshotRetention?: { keepLast?: number; maxAgeDays?: number };
  /** Deterministic child session id to expose to newly spawned agents (#1925). */
  sessionId?: string;
  fromSnapshot?: boolean;
  snapshotId?: string;
  /** Filesystem layout for newly-created worktrees (#1850): default nested, legacy sibling via --layout legacy. */
  layout?: WorktreeLayout;
  /** Force Discord channel launch for Claude-like engines (#1999). */
  channels?: boolean;
  /** Wait until the engine process is detected after sending bootstrap commands. Default wake returns immediately (#2661). */
  wait?: boolean;
  /** Explicit wake session mode override. Auto mode infers from the resolved repo suffix. */
  sessionMode?: WakeSessionMode;
}

function isAttachOnlyWake(opts: WakeOptions): boolean {
  return Boolean(opts.attach)
    && !opts.task
    && !opts.wt
    && !opts.prompt
    && !opts.session
    && !opts.incubate
    && !opts.fresh
    && !opts.pick
    && !opts.name
    && !opts.listWt
    && !opts.dryRun
    && !opts.split
    && !opts.splitTarget
    && !opts.bringAlias
    && !opts.bring
    && !opts.tab
    && !opts.bud
    && !opts.signalOnBirth
    && !opts.engine
    && !opts.channels
    && !opts.wait
    && !opts.fromSnapshot
    && !opts.snapshotId;
}

type WakeCommandOptions = Pick<WakeOptions, "engine" | "parentSessionId" | "sessionId" | "channels"> & {
  /** Strip engine resume/continue placeholders for reboot-rehydrated dead panes (#2391). */
  freshLaunch?: boolean;
};

function buildWakeCommand(windowName: string, cwd: string, opts: WakeCommandOptions): string {
  const commandOpts = opts.channels
    ? { engine: opts.engine, channels: ["plugin:discord@claude-plugins-official"], fresh: opts.freshLaunch }
    : opts.freshLaunch
      ? { engine: opts.engine, fresh: true }
      : opts.engine;
  return prefixCommandWithSpawnSessionEnv(
    buildCommandInDir(windowName, cwd, commandOpts),
    { explicit: opts.parentSessionId, sessionId: opts.sessionId, cwd },
  );
}

async function buildWakeCommandForPane(windowName: string, cwd: string, opts: WakeCommandOptions, target: string): Promise<string> {
  const infos = await getPaneInfos([target]).catch(() => ({} as Awaited<ReturnType<typeof getPaneInfos>>));
  const command = infos[target]?.command;
  const freshLaunch = !isAgentCommand(command);
  return buildWakeCommand(windowName, cwd, freshLaunch ? { ...opts, freshLaunch: true } : opts);
}

function loadRequestedSnapshot(snapshotId?: string): Snapshot | null {
  const snapshots = listSnapshots();
  if (snapshotId) {
    const match = snapshots.find(({ file }) =>
      file === snapshotId ||
      file === `${snapshotId}.json` ||
      file.startsWith(snapshotId)
    );
    if (!match) return null;
    return loadSnapshot(match.file) || null;
  }

  if (!snapshots[0]) return null;
  return loadSnapshot(snapshots[0].file) || null;
}

function resolveSnapshotSourceFile(snapshot: Snapshot): string {
  const fromTimestamp = snapshot.timestamp;
  const listed = listSnapshots();
  return listed.find(({ timestamp }) => timestamp === fromTimestamp)?.file
    ?? `${fromTimestamp}.json`;
}

function formatWorktreeSource(path: string): string {
  const marker = "/agents/";
  const idx = path.lastIndexOf(marker);
  if (idx >= 0) return `agents/${path.slice(idx + marker.length)}`;
  const base = path.split("/").filter(Boolean).pop();
  return `worktree/${base}`;
}

function rehydrationWindowLabel(count: number): string {
  return `${count} window${count === 1 ? "" : "s"}`;
}

function agentsRehydrationSource(worktrees: { path: string }[]): string {
  const agentsPath = worktrees
    .map(wt => wt.path)
    .find(path => path.includes("/agents/"));
  if (agentsPath) {
    return agentsPath.slice(0, agentsPath.indexOf("/agents/") + "/agents".length);
  }
  return worktrees.length > 0 ? "worktree folders" : "agents/ folder";
}

function logSnapshotRehydrationSource(count: number, snapshotFile: string): void {
  if (count > 0) {
    console.log(`\x1b[36m↻\x1b[0m Rehydrating ${rehydrationWindowLabel(count)} from snapshot ${snapshotFile}`);
    return;
  }
  console.log(`\x1b[90m↻ snapshot rehydrate: none from snapshot ${snapshotFile}\x1b[0m`);
}

function logAgentsRehydrationSource(count: number, worktrees: { path: string }[]): void {
  const source = agentsRehydrationSource(worktrees);
  if (count > 0) {
    console.log(`\x1b[36m↻\x1b[0m Rehydrating ${rehydrationWindowLabel(count)} from agents/ state at ${source}`);
    return;
  }
  console.log(`\x1b[90m↻ agents/ rehydrate: none from ${source}\x1b[0m`);
}

export function parseRehydrationSelection(input: string, count: number): number[] {
  const selected = new Set<number>();
  for (const rawPart of input.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let index = lo; index <= hi; index++) {
        if (index >= 1 && index <= count) selected.add(index - 1);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= 1 && index <= count) selected.add(index - 1);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

function selectAgentsRehydrationPlan(plan: RehydrateWorktreePlan[]): RehydrateWorktreePlan[] {
  if (plan.length === 0 || !_wtPicker.isStdoutTTY()) return plan;
  console.log(`\x1b[36m↻\x1b[0m found ${plan.length} saved agent window${plan.length === 1 ? "" : "s"}:`);
  for (const wt of plan) {
    console.log(`  \x1b[90m${wt.windowName.padEnd(40)} ${formatWorktreeSource(wt.path)}\x1b[0m`);
  }
  console.log("");
  process.stdout.write(`  Rehydrate? [Y]es all / [n]one / [s]elect: `);
  const answer = (_wtPicker.readChoice() || "").trim();
  if (/^n/i.test(answer)) return [];
  if (!/^s/i.test(answer)) return plan;

  console.log(`\x1b[36m↻\x1b[0m select saved agent windows:`);
  plan.forEach((wt, index) => {
    console.log(`  \x1b[36m${index + 1}\x1b[0m) ${wt.windowName}  \x1b[90m${formatWorktreeSource(wt.path)}\x1b[0m`);
  });
  process.stdout.write(`  → `);
  const rawSelection = _wtPicker.readChoice() || "";
  const selectedIndices = parseRehydrationSelection(rawSelection, plan.length);
  const selectedPlan = selectedIndices.map(index => plan[index]!).filter(Boolean);
  if (selectedPlan.length > 0) {
    console.log(`\x1b[32m✓\x1b[0m rehydrating: ${selectedPlan.map(wt => wt.windowName).join(", ")}`);
  }
  return selectedPlan;
}

async function restoreSnapshotWindows(
  oracle: string,
  session: string,
  snapshotSession: SnapshotSession,
  existingWindows: Set<string>,
  worktrees: { name: string; path: string }[],
  repoPath: string,
  snapshotFile: string,
  engine?: string,
): Promise<number> {
  const planned = planSnapshotRestoreWindows(oracle, snapshotSession, existingWindows, worktrees, repoPath);
  logSnapshotRehydrationSource(planned.length, snapshotFile);
  if (planned.length > 0) {
    console.log(`\x1b[36m↻\x1b[0m rehydrating from snapshot ${snapshotFile}:`);
  }
  for (const win of planned) {
    await tmux.newWindow(session, win.windowName, { cwd: win.cwd });
    await tmux.sendText(`${session}:${win.windowName}`, buildWakeCommand(win.windowName, win.cwd, { engine }));
    existingWindows.add(win.windowName);
    const label = win.source === "worktree" ? "worktree" : "repo";
    console.log(`\x1b[36m↻\x1b[0m snapshot window: ${win.windowName}  \x1b[90m${label}: ${win.cwd} (from snapshot)\x1b[0m`);
  }
  return planned.length;
}


export function validateForeignSessionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new Error(`invalid target session '${name}' — use letters, numbers, dot, underscore, or dash`);
  }
}

function sessionFromTmuxTarget(target: string | undefined): string | null {
  if (!target) return null;
  const session = target.split(":")[0]?.trim();
  return session || null;
}

async function currentTmuxSessionFromPane(): Promise<string | null> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  try {
    const safePane = pane.replace(/'/g, "'\\''");
    const raw = await hostExec(`tmux display-message -p -t '${safePane}' '#{session_name}'`);
    const out = String(raw).trim();
    return out || null;
  } catch {
    return null;
  }
}

function isClaudeEngine(engine: string | undefined): boolean {
  let config: Partial<import("../../config/types").MawConfig> = {};
  try {
    config = loadConfig();
  } catch {
    // fall back to registry defaults when config is unreadable
  }
  return isClaudeLikeEngine(engine, config);
}

async function sendPromptViaTmux(target: string, prompt: string): Promise<void> {
  const runner = (tmux as unknown as { run?: (subcommand: string, ...args: Array<string | number>) => Promise<string> }).run;
  if (typeof runner === "function") {
    await runner.call(tmux, "send-keys", "-t", target, prompt, "Enter");
    return;
  }
  await tmux.sendText(target, prompt);
}

async function sendWakeCommandAndPrompt(target: string, prompt: string | undefined, command: string, _engine?: string): Promise<void> {
  await tmux.sendText(target, command);
  if (prompt) {
    await sendPromptViaTmux(target, prompt);
  }
}

async function findLiveWindowsByName(windowName: string): Promise<LiveWindowMatch[]> {
  const wanted = windowName.trim();
  if (!wanted) return [];
  const sessions = await tmux.listSessions().catch(() => [] as { name: string }[]);
  const matches: LiveWindowMatch[] = [];
  for (const session of sessions) {
    const windows = await tmux.listWindows(session.name).catch(() => [] as { name: string }[]);
    for (const window of windows) {
      if (window.name !== wanted) continue;
      matches.push({
        session: session.name,
        window: window.name,
        target: `${session.name}:${window.name}`,
      });
    }
  }
  return matches;
}

function formatBringWindowTargets(matches: LiveWindowMatch[]): string {
  return matches.map(match => `    ${match.target}`).join("\n");
}

function bringUserError(message: string): UserError {
  console.error(`error: ${message}`);
  return new UserError(message);
}

function buildAmbiguousBringDestinationError(
  source: string,
  destination: string,
  matches: LiveWindowMatch[],
): UserError {
  return bringUserError(
    [
      `target session '${destination}' not found, but '${destination}' matches multiple live tmux windows.`,
      "",
      "  Use an explicit session:window destination:",
      formatBringWindowTargets(matches),
      "",
      `  Example: maw bring ${source} --to ${matches[0]?.target ?? "<session>:<window>"}`,
    ].join("\n"),
  );
}

async function normalizeBringDestinationWindow(source: string, opts: WakeOptions): Promise<void> {
  if (!opts.bringAlias) return;
  if (!opts.session || opts.splitTarget) return;
  const destination = opts.session.trim();
  if (!destination || destination.includes(":")) return;
  const sessionExists = await tmux.hasSession(destination).catch(() => false);
  if (sessionExists) return;

  const matches = await findLiveWindowsByName(destination);
  if (matches.length === 0) return;
  if (matches.length > 1) {
    if (opts.pick) {
      const picked = promptAmbiguousBringPick(
        destination,
        matches.map(match => ({
          name: match.window,
          target: match.target,
          detail: `tmux window in ${match.session}`,
        })),
      );
      if (picked) {
        const [session, ...windowParts] = picked.target.split(":");
        opts.session = session || picked.target;
        opts.splitTarget = picked.target;
        opts.resolvedBringDestinationWindow = {
          session: session || picked.target,
          window: windowParts.join(":") || picked.name,
          target: picked.target,
        };
        return;
      }
    }
    throw buildAmbiguousBringDestinationError(source, destination, matches);
  }

  const match = matches[0]!;
  opts.session = match.session;
  opts.splitTarget = match.target;
  opts.resolvedBringDestinationWindow = match;
}

async function resolveExistingWindowBringTarget(
  targetName: string,
  opts: WakeOptions,
  preResolvedSession: string | null,
): Promise<string | null> {
  if (!opts.bringAlias) return null;
  if (opts.task || opts.wt || opts.incubate || opts.repoPath || opts.urlRepoName) return null;

  const session =
    opts.session?.trim() ||
    sessionFromTmuxTarget(opts.splitTarget) ||
    preResolvedSession ||
    await currentTmuxSessionFromPane();
  if (!session) return null;

  const windows = await tmux.listWindows(session).catch(() => [] as { name: string }[]);
  const exact = windows.find(w => w.name === targetName);
  if (exact) return `${session}:${exact.name}`;

  const candidates = resolveBringWindowCandidates(
    targetName,
    await buildBringWindowCandidates(session, windows),
  );
  if (opts.resolvedBringDestinationWindow && !opts.pick && candidates.length > 0) {
    const suggestion = candidates[0]!;
    throw bringUserError(
      [
        `bring target '${targetName}' is not an exact live window in ${session}.`,
        "",
        `  Did you mean to target the window '${opts.resolvedBringDestinationWindow.window}' in an existing session?`,
        `  Try: maw bring ${suggestion.name} --to ${opts.resolvedBringDestinationWindow.target}`,
        "",
        "  Or add --pick to choose from live window candidates.",
      ].join("\n"),
    );
  }

  if (opts.pick) {
    if (candidates.length > 0) {
      const picked = promptAmbiguousBringPick(targetName, candidates);
      if (!picked) throw new Error(`--pick requires an interactive bring selection for '${targetName}'`);
      return picked.target;
    }
  }

  return null;
}

async function resolveExistingSessionBringTarget(
  targetName: string,
  opts: WakeOptions,
  preResolvedSession: string | null,
): Promise<string | null> {
  if (!opts.bringAlias) return null;
  if (opts.task || opts.wt || opts.incubate || opts.repoPath || opts.urlRepoName) return null;
  const sessionName = (preResolvedSession || targetName).trim();
  if (!sessionName || sessionName.includes(":")) return null;
  const sessions = await tmux.listSessions().catch(() => [] as { name: string }[]);
  return sessions.some(s => s.name === sessionName) ? sessionName : null;
}

export type WakeFleetSessionMetadata = {
  session: string;
  oracle: string;
  windowName: string;
  repo: string;
};

function normalizeFleetRepoSlug(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^github\.com\//i, "");
}

function fleetRepoStem(repo: string): string {
  const slug = normalizeFleetRepoSlug(repo);
  return slug.split("/").filter(Boolean).pop() || slug;
}

function primaryFleetOracleWindow(session: FleetSession): { name: string; repo: string } | null {
  const windows = (session.windows || []).filter((w): w is { name: string; repo: string } => Boolean(w?.name && w?.repo));
  return windows.find(w => Boolean(stripOracleRepoSuffix(w.name))) || windows[0] || null;
}

export function resolveWakeFleetSessionMetadata(
  sessionName: string,
  fleetSessions: FleetSession[],
): WakeFleetSessionMetadata | null {
  const session = fleetSessions.find(s => s.name === sessionName);
  if (!session) return null;
  const window = primaryFleetOracleWindow(session);
  if (!window) return null;
  const oracle = stripOracleRepoSuffix(window.name)
    || stripOracleRepoSuffix(fleetRepoStem(window.repo))
    || session.name.replace(/^\d+-/, "");
  return {
    session: session.name,
    oracle,
    windowName: window.name,
    repo: normalizeFleetRepoSlug(window.repo),
  };
}

async function loadWakeFleetSessions(): Promise<FleetSession[]> {
  try {
    const { loadFleet } = await import("./fleet-load");
    return loadFleet();
  } catch {
    // Some isolated tests mock the SDK facade narrowly and intentionally omit
    // fleet constants. Fleet metadata is an optimization for exact numeric
    // targets, so a load failure should fall back to the pre-#1892 resolver
    // path rather than breaking ordinary wake paths.
    return [];
  }
}

const DEFAULT_WAKE_FLEET_GHQ_GET_TIMEOUT_MS = 10_000;

function wakeFleetGhqGetTimeoutMs(): number {
  const raw = process.env.MAW_WAKE_GHQ_GET_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_WAKE_FLEET_GHQ_GET_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WAKE_FLEET_GHQ_GET_TIMEOUT_MS;
}

function isWakeFleetCloneTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out after \d+ms/.test(error.message);
}

async function hostExecWakeFleetGhqGet(command: string, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      hostExec(command, undefined, { timeoutMs }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function wakeFleetManualCloneHint(cloneSlug: string, oracle: string): string {
  return `ghq get github.com/${cloneSlug} && maw wake ${oracle}`;
}

async function resolveWakeFleetSessionRepo(meta: WakeFleetSessionMetadata): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  const repoStem = fleetRepoStem(meta.repo);
  const existing = await ghqFind(`/${meta.repo}`) || await ghqFind(`/${repoStem}`);
  if (existing) {
    return { repoPath: existing, repoName: existing.split("/").pop()!, parentDir: existing.replace(/\/[^/]+$/, "") };
  }

  const cloneSlug = meta.repo.replace(/^github\.com\//i, "");
  const timeoutMs = wakeFleetGhqGetTimeoutMs();
  const hint = wakeFleetManualCloneHint(cloneSlug, meta.oracle);
  console.log(`\x1b[36m🌱\x1b[0m ${meta.session} pinned in fleet → github.com/${cloneSlug} — checking ghq clone (bounded ${Math.ceil(timeoutMs / 1000)}s)...`);
  try {
    await hostExecWakeFleetGhqGet(`ghq get 'github.com/${cloneSlug}'`, timeoutMs);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const reason = isWakeFleetCloneTimeout(e) ? `timed out after ${timeoutMs}ms` : msg.split("\n")[0];
    console.error(`\x1b[33m⚠\x1b[0m fleet-pinned ${cloneSlug} clone failed: ${reason}`);
    console.error(`\x1b[90m  run manually: ${hint}\x1b[0m`);
  }
  const cloned = await ghqFind(`/${meta.repo}`) || await ghqFind(`/${repoStem}`);
  if (cloned) {
    console.log(`\x1b[32m✓\x1b[0m found at ${cloned}`);
    return { repoPath: cloned, repoName: cloned.split("/").pop()!, parentDir: cloned.replace(/\/[^/]+$/, "") };
  }
  console.error(`\x1b[31merror\x1b[0m: fleet-pinned ${meta.repo} for session ${meta.session} is not cloned locally`);
  console.error(`\x1b[90m  run manually: ${hint}\x1b[0m`);
  throw new Error(`fleet-pinned ${meta.repo} for session ${meta.session} not found locally; run ${hint}`);
}

export async function chooseWakeSessionName(oracle: string, urlRepoName?: string): Promise<string> {
  const mappedOrFleet = getSessionMap()[oracle] || resolveFleetSession(oracle);
  const baseName = mappedOrFleet || canonicalSessionName(urlRepoName || oracle);
  if (/^\d+-/.test(baseName)) return baseName;
  // #994 — auto-assign NN- prefix to match fleet convention (01-maw-m5, 02-...).
  // Scan existing sessions for numeric prefixes, pick max+1, zero-pad to 2 digits.
  const sessions = await tmux.listSessions().catch(() => [] as { name: string }[]);
  let maxNum = 0;
  for (const s of sessions) {
    const m = s.name.match(/^(\d+)-/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  return `${String(maxNum + 1).padStart(2, "0")}-${baseName}`;
}

/**
 * Resolve the tmux session the operator ran `maw wake` from (#2557).
 *
 * Only consulted for `--task`/`--wt` placement so a budded oracle's worktree
 * window lands in the current session instead of an unrelated workspace that
 * happens to host the repo. Returns null when not inside tmux or on any tmux
 * error, which makes detectSession fall back to its historical ordering.
 */
async function resolveInvokingTmuxSession(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const name = (await tmux.run("display-message", "-p", "#{session_name}")).trim();
    return name || null;
  } catch {
    return null;
  }
}

type WakeWindowLookupEntry = { name: string; cwd?: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findExistingWakeWindowEntry<T extends WakeWindowLookupEntry>(
  windows: Iterable<T>,
  oracle: string,
  windowName: string,
): T | undefined {
  const entries = [...windows];
  const nameSuffix = windowName.startsWith(`${oracle}-`)
    ? windowName.slice(`${oracle}-`.length)
    : windowName;
  const numberedPattern = new RegExp(`^${escapeRegExp(oracle)}-\\d+-${escapeRegExp(nameSuffix)}$`);
  return entries.find(w => w.name === windowName)
    || entries.find(w => numberedPattern.test(w.name));
}

function findExistingWakeWindow(windowNames: Iterable<string>, oracle: string, windowName: string): string | undefined {
  return findExistingWakeWindowEntry([...windowNames].map(name => ({ name })), oracle, windowName)?.name;
}

export function shouldMarkWakeInboxRead(opts: Pick<WakeOptions, "dryRun" | "listWt">, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAW_ATTACH_FOLLOWS === "1" && !opts.dryRun && !opts.listWt;
}

export async function cmdWake(oracle: string, opts: WakeOptions): Promise<string> {
  // Canonicalize the bare name before any lookup — strips trailing `/`, `/.git`, `/.git/`
  // so `maw wake token-oracle/` (tab-completion artifact) resolves the same as `token-oracle`.
  oracle = normalizeTarget(oracle);

  // #2569 — zero-arg wake: `maw wake` (or `maw wake .`) inside an oracle repo
  // derives the oracle from the current directory, then runs the normal flow.
  if (!oracle || oracle === ".") {
    const derived = deriveOracleFromCwd(process.cwd());
    if (!derived) {
      throw new UserError(
        "maw wake: no oracle name given and the current directory is not an oracle repo.\n" +
        "Run inside an oracle repo or its worktree, or pass a name: maw wake <oracle>.",
      );
    }
    console.log(`\x1b[36m→\x1b[0m wake: derived oracle '\x1b[1m${derived}\x1b[0m' from cwd ${process.cwd()}`);
    oracle = derived;
  }

  const requestedTarget = oracle;
  const parsed = parseWakeTarget(oracle);
  let parsedRepoPath: string | null = null;
  if (parsed) {
    await ensureCloned(parsed.slug);
    // #1635 — full org/repo input is an explicit disambiguation. Preserve the
    // exact cloned/local slug instead of later resolving the bare oracle name
    // through `ghqFind(/repo)`, which can silently pick a different org.
    parsedRepoPath = await ghqFind(`/${parsed.slug}`);
    if (!opts.urlRepoName) opts.urlRepoName = parsed.slug.split("/").pop();
  }

  if (!opts.sessionMode && !parsed && !opts.repoPath && !opts.incubate) {
    const candidateRepo = repoNameFromTarget(requestedTarget, opts.urlRepoName);
    const workRepoPath = await ghqFind(`/${candidateRepo}`);
    if (workRepoPath && !repoNameFromPath(workRepoPath).toLowerCase().endsWith("-oracle")) {
      parsedRepoPath = workRepoPath;
      opts = { ...opts, urlRepoName: repoNameFromPath(workRepoPath) };
    }
  }

  let sessionContext = detectWakeSessionMode(requestedTarget, opts);
  oracle = parsed && sessionContext.mode === "oracle" ? parsed.oracle : repoNameFromTarget(requestedTarget, opts.urlRepoName);

  // #358 — reject -view suffix at the user-input boundary (before any session work).
  assertValidOracleName(oracle);
  let preResolvedSession: string | null = null;
  let preResolvedFleetSession: WakeFleetSessionMetadata | null = null;
  const numericFleetTarget = oracle.match(/^\d+-(.+)$/);
  if (numericFleetTarget) {
    // #1469 — a user may pass the exact live tmux session (`48-foo`) to
    // bring/split. Prefer that exact session before resolving a repo; then
    // strip the fleet prefix only for repo/oracle lookup (`foo-oracle`).
    const sessions = await tmux.listSessions().catch(() => [] as { name: string }[]);
    const sessionIsLive = sessions.some(s => s.name === oracle);
    // #1892 — if that exact session is fleet-registered, its window/repo
    // metadata is authoritative even while the session is sleeping. Do not
    // re-fuzzy the compact session stem (`79-mawjscodex` → `mawjscodex`)
    // through local repos; that can match sibling repos such as `mawjs-oracle`.
    // Preserve the fleet window stem for tmux names and resolve the fleet-
    // pinned repo directly below.
    preResolvedFleetSession = resolveWakeFleetSessionMetadata(oracle, await loadWakeFleetSessions());
    if (preResolvedFleetSession) {
      if (sessionIsLive) preResolvedSession = oracle;
      oracle = preResolvedFleetSession.oracle;
    } else if (sessionIsLive) {
      preResolvedSession = oracle;
      oracle = numericFleetTarget[1]!;
    }
  }
  await normalizeBringDestinationWindow(oracle, opts);
  const requestedForeignSession = opts.session?.trim();
  if (requestedForeignSession) validateForeignSessionName(requestedForeignSession);

  console.log(`\x1b[36m⚡\x1b[0m resolving ${oracle}...`);

  // #1897 — explicit attach is a tmux client handoff, not bring delivery.
  // When the target is already live, avoid the bring/split/open-window pipeline
  // and skip wake maintenance work that can mutate tmux windows before the
  // attach. Missing sessions still fall through to normal wake/create behavior.
  if (isAttachOnlyWake(opts)) {
    const liveAttachSession = preResolvedSession || await detectSession(oracle, opts.urlRepoName);
    if (liveAttachSession) {
      console.log(`\x1b[36m→\x1b[0m live tmux session: ${liveAttachSession}`);
      await wakeSession.attachToSession(liveAttachSession);
      await recordWakeSnapshot(opts);
      const attachWindow = preResolvedFleetSession?.windowName || mainWindowNameForWakeSession(sessionContext, oracle);
      return `${liveAttachSession}:${attachWindow}`;
    }
  }

  const existingSessionBringTarget = await resolveExistingSessionBringTarget(oracle, opts, preResolvedSession);
  if (existingSessionBringTarget) {
    console.log(`\x1b[36m→\x1b[0m live tmux session: ${existingSessionBringTarget}`);
    if (opts.dryRun) {
      console.log(`\x1b[90mdry-run — no tmux sessions/windows will be changed\x1b[0m`);
      return existingSessionBringTarget;
    }
    await maybeSplit(existingSessionBringTarget, opts);
    await maybeOpenWindow(existingSessionBringTarget, opts);
    await recordWakeSnapshot(opts);
    return existingSessionBringTarget;
  }

  const existingWindowBringTarget = await resolveExistingWindowBringTarget(oracle, opts, preResolvedSession);
  if (existingWindowBringTarget) {
    console.log(`\x1b[36m→\x1b[0m live tmux window: ${existingWindowBringTarget}`);
    if (opts.dryRun) {
      console.log(`\x1b[90mdry-run — no tmux sessions/windows will be changed\x1b[0m`);
      return existingWindowBringTarget;
    }
    await maybeSplit(existingWindowBringTarget, opts);
    await recordWakeSnapshot(opts);
    return existingWindowBringTarget;
  }

  let resolved: { repoPath: string; repoName: string; parentDir: string };

  if (sessionContext.mode === "work") {
    resolved = await resolveWorkRepository(requestedTarget, parsedRepoPath, opts);
  } else if (opts.repoPath) {
    // #421 — caller already knows the exact on-disk path (e.g. `maw bud --org`
    // just cloned it). Skip resolveOracle so a stale same-named repo in a
    // different org can't shadow the freshly-created one.
    const repoPath = opts.repoPath;
    resolved = { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
  } else if (parsedRepoPath) {
    const repoPath = parsedRepoPath;
    resolved = { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
  } else if (preResolvedFleetSession) {
    resolved = await resolveWakeFleetSessionRepo(preResolvedFleetSession);
  } else if (opts.incubate) {
    const slug = opts.incubate;
    // CodeQL js/incomplete-url-substring-sanitization: use prefix anchor, not
    // substring match — `attacker.com/github.com/...` would have passed .includes.
    const repoSlug = (
      slug.startsWith("github.com/") ||
      slug.startsWith("https://github.com/") ||
      slug.startsWith("http://github.com/")
    ) ? slug : `github.com/${slug}`;
    console.log(`\x1b[36m⚡\x1b[0m incubating ${slug}...`);
    await hostExec(`ghq get -u ${repoSlug}`);
    const fullPath = await ghqFind(repoSlug);
    if (!fullPath) throw new Error(`ghq could not find ${slug} after clone`);
    const repoPath = fullPath;
    resolved = { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
    if (!opts.task && !opts.wt) opts.wt = resolved.repoName.replace(/-/g, "");
  } else {
    resolved = await resolveOracle(oracle, { allLocal: opts.allLocal, quietWorktreeScan: !!opts.dryRun });
  }

  const { repoPath, repoName, parentDir } = resolved;
  const config = loadConfig();
  const worktreeLayout = normalizeWorktreeLayout(opts.layout);

  if (opts.bud && !opts.task && !opts.wt) {
    throw new Error("--bud requires --task <slug> or --wt <slug>");
  }

  if (opts.signalOnBirth && !opts.bud) {
    throw new Error("--signal-on-birth requires --bud");
  }

  // #2598 — Session(mode) owns the identity source. Oracle sessions strip the
  // repo suffix; work sessions use the repo name verbatim.
  sessionContext = new WakeSession(sessionContext.mode);
  const resolvedIdentity = identityForWakeSession(sessionContext, repoName, oracle);
  if (!preResolvedFleetSession && resolvedIdentity !== oracle) {
    oracle = resolvedIdentity;
  }
  // #673 — extract org/repo slug from ghq path (…/github.com/<org>/<repo>)
  const ghSlug = repoPath.includes("github.com/")
    ? repoPath.slice(repoPath.indexOf("github.com/") + "github.com/".length)
    : repoName;
  console.log(`\x1b[36m→\x1b[0m found \x1b[1m${ghSlug}\x1b[0m (${repoPath})`);

  // #1563 — `maw wake <oracle> --list` is a preview/read-only query.
  // Keep it before detectSession/newSession/respawn so it never creates or
  // rehydrates tmux windows just to show worktrees.
  if (opts.listWt) {
    const worktrees = await findWorktrees(parentDir, repoName);
    if (!worktrees.length) { console.log(`\x1b[90mNo worktrees for ${oracle}.\x1b[0m`); }
    else {
      const sessionSummaries = await worktreeSessionSummaries(worktrees);
      console.log(`\n\x1b[36mWorktrees for ${oracle}\x1b[0m (${worktrees.length})\n`);
      for (const wt of worktrees) {
        const summary = formatWorktreeSessionSummary(sessionSummaries.get(wt.name));
        console.log(`  \x1b[32m●\x1b[0m ${wt.name}  \x1b[90m${wt.path}\x1b[0m${summary}`);
      }
    }
    return `${oracle}:list`;
  }

  // #2609 — fuzzy attach targets may only resolve to the canonical oracle name
  // after resolveOracle() (e.g. `transcri` → `transcriber`). If that canonical
  // session is already live and has its oracle window, this is a re-attach: do
  // not drain inbox or run agents/ rehydrate again. The first wake still falls
  // through because there is no live session/window yet.
  if (isAttachOnlyWake(opts)) {
    const liveAttachSession = preResolvedSession || await detectSession(oracle, opts.urlRepoName);
    if (liveAttachSession) {
      const attachWindow = preResolvedFleetSession?.windowName || mainWindowNameForWakeSession(sessionContext, oracle);
      const liveWindows = await tmux.listWindows(liveAttachSession).catch(() => [] as { name: string }[]);
      if (liveWindows.some(w => w.name === attachWindow)) {
        console.log(`\x1b[36m→\x1b[0m session exists: ${liveAttachSession}`);
        await tmux.selectWindow(`${liveAttachSession}:${attachWindow}`);
        await wakeSession.attachToSession(liveAttachSession);
        await recordWakeSnapshot(opts);
        return `${liveAttachSession}:${attachWindow}`;
      }
    }
  }

  const drainedInbox = drainWakeInbox(repoPath, { markRead: shouldMarkWakeInboxRead(opts), engine: opts.engine });
  if (drainedInbox.prompt.trim()) {
    opts = { ...opts, prompt: mergeWakeInboxPrompt(opts.prompt, drainedInbox.prompt) };
  }
  if (drainedInbox.count > 0) {
    console.log(`\x1b[36m📬\x1b[0m ${drainedInbox.count} unread ψ/inbox message${drainedInbox.count === 1 ? "" : "s"}; left unread for maw inbox --unread`);
  }

  const foreignSession = requestedForeignSession;
  // #2557 — task/worktree wakes prefer the invoking session for placement so the
  // new agent window lands where the operator ran the command, not in an
  // unrelated workspace that the fleet registry happens to map the repo to.
  const invokingSession = (opts.task || opts.wt) ? await resolveInvokingTmuxSession() : null;
  let session = foreignSession ? "" : (preResolvedSession || await detectSession(oracle, opts.urlRepoName, { invokingSession }));
  if (foreignSession) {
    const exists = opts.dryRun || await tmux.hasSession(foreignSession);
    if (exists) {
      session = foreignSession;
      console.log(`\x1b[36m→\x1b[0m target workspace session: ${foreignSession}`);
    } else {
      console.log(`\x1b[36m→\x1b[0m target workspace session missing, creating: ${foreignSession}`);
    }
  } else if (session) console.log(`\x1b[36m→\x1b[0m session exists: ${session}`);
  else console.log(`\x1b[36m→\x1b[0m no session found, creating...`);

  const requestedSnapshot = opts.fromSnapshot ? loadRequestedSnapshot(opts.snapshotId) : null;
  if (opts.fromSnapshot && !requestedSnapshot) {
    throw new Error(opts.snapshotId ? `snapshot not found: ${opts.snapshotId}` : "no snapshot found");
  }
  const requestedSnapshotSession = requestedSnapshot ? findWakeSnapshotSession(requestedSnapshot, oracle, session) : null;
  const requestedSnapshotFile = requestedSnapshot ? resolveSnapshotSourceFile(requestedSnapshot) : null;
  if (opts.fromSnapshot && requestedSnapshot && !requestedSnapshotSession) {
    throw new Error(`snapshot ${requestedSnapshot.timestamp} has no session for ${oracle}`);
  }

  // #835 — consult unified shouldAutoWake. cmdWake is idempotent: if the
  // session already exists, the helper returns wake=false and we skip the
  // session-create branch (we still proceed to attach/select-window below).
  // This makes the "wakes if missing" decision explicit + auditable.
  const { shouldAutoWake } = await import("./should-auto-wake");
  const wakeDecision = shouldAutoWake(oracle, {
    site: "wake-cmd",
    isLive: Boolean(session),
  });

  const mainWindowName = foreignSession ? oracle : mainWindowNameForWakeSession(sessionContext, oracle);
  const shouldCreateSession = !session && (wakeDecision.wake || Boolean(foreignSession));
  // Per-worktree rehydration is OPT-IN (default OFF) — thread #14 / owner GO
  // 2026-06-11. Plain `maw wake <role>` must touch only the role window and not
  // fan out a `<role>-<wt-suffix>` window per worktree on disk. Gated below.
  const doRehydrate = shouldRehydrateWorktrees(opts, config);

  if (opts.dryRun) {
    console.log(`\x1b[90mdry-run — no tmux sessions/windows will be changed\x1b[0m`);
    if (foreignSession) {
      console.log(`\x1b[32m+\x1b[0m would wake window '${mainWindowName}' in workspace session '${foreignSession}'`);
    } else if (shouldCreateSession) {
      const plannedSession = await chooseWakeSessionName(oracle, opts.urlRepoName);
      console.log(`\x1b[32m+\x1b[0m would create session '${plannedSession}' (main: ${mainWindowName})`);
    } else if (session) {
      console.log(`\x1b[36m→\x1b[0m would reuse session: ${session}`);
    }

    if (opts.task || opts.wt) {
      console.log(`\x1b[33m⚡\x1b[0m would wake worktree/task: ${sanitizeBranchName(opts.wt || opts.task!)}`);
      if (opts.bud) console.log(`\x1b[90m🌱 would stamp wake-bud lineage for ${oracle}\x1b[0m`);
      if (opts.bud && opts.signalOnBirth) console.log(`\x1b[90m⬡ would drop wake-bud birth signal in ${oracle}'s ψ/memory/signals/\x1b[0m`);
      return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
    }

    const allWt = await findWorktrees(parentDir, repoName);
    const existingWindows = session
      ? (await tmux.listWindows(session).catch(() => [] as { name: string }[])).map(w => w.name)
      : [];
    if (requestedSnapshotSession) {
      const planned = planSnapshotRestoreWindows(oracle, requestedSnapshotSession, existingWindows, allWt, repoPath);
      if (planned.length === 0) {
        console.log(`\x1b[90m↻ would restore snapshot windows: none\x1b[0m`);
        logSnapshotRehydrationSource(0, requestedSnapshotFile || "snapshot");
      } else {
        logSnapshotRehydrationSource(planned.length, requestedSnapshotFile || "snapshot");
        if (requestedSnapshotFile) {
          console.log(`\x1b[36m↻\x1b[0m rehydrating from snapshot ${requestedSnapshotFile}:`);
        }
        for (const win of planned) {
          console.log(`\x1b[36m↻\x1b[0m would restore snapshot window: ${win.windowName}  \x1b[90m${win.cwd} (from snapshot)\x1b[0m`);
        }
      }
    }

    if (!doRehydrate || foreignSession) {
      const reason = foreignSession
        ? "foreign workspace session"
        : opts.noRehydrate
          ? "--main/--solo/--no-rehydrate"
          : "opt-in only — pass --respawn-worktrees (or config respawnWorktrees:true)";
      console.log(`\x1b[90m↻ worktree rehydrate skipped (${reason})\x1b[0m`);
      return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
    }

    const liveTileRoles = session ? await getLiveTileRoles(session) : new Set<string>();
    const rehydratableWt = await filterMergedWorktreesForRehydrate(allWt, { hostExec, baseBranch: "alpha" });
    const planned = planRehydrateWorktreeWindows(oracle, rehydratableWt, existingWindows, liveTileRoles);
    if (planned.length === 0) {
      console.log(`\x1b[90m↻ would respawn: none\x1b[0m`);
      logAgentsRehydrationSource(0, allWt);
    } else {
      logAgentsRehydrationSource(planned.length, allWt);
      console.log(`\x1b[36m↻\x1b[0m rehydrating from agents/ folder:`);
      for (const wt of planned) {
        console.log(`\x1b[32m↻\x1b[0m would respawn: ${wt.windowName}  \x1b[90m(from ${formatWorktreeSource(wt.path)})\x1b[0m`);
      }
    }
    return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
  }

  ensureWakeSessionVault(sessionContext, repoPath);

  let knownWindows = new Set<string>();
  let knownWindowEntries: WakeWindowLookupEntry[] = [];
  let knownWindowsReliable = true;

  if (shouldCreateSession) {
    // #2 — refuse to spawn a brand-new session/agent once the fleet is at the
    // configured concurrency cap (no-op when limits.maxConcurrentAgents is explicitly 0).
    await assertAgentCapacity(oracle);

    // #769 — URL input names the new session after the full repo (e.g.
    // "m5-oracle") so it's distinct from any unrelated sub-token sessions
    // and immediately disambiguates future `maw wake` calls.
    session = foreignSession || await chooseWakeSessionName(oracle, opts.urlRepoName);
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await retryFreshSessionTmuxStep(session, "set session environment", () => setSessionEnv(session), {
      hasSession: tmux.hasSession,
    });
    await retryFreshSessionTmuxStep(session, "launch main window", () => {
      const command = buildWakeCommand(mainWindowName, repoPath, opts);
      return sendWakeCommandAndPrompt(`${session}:${mainWindowName}`, opts.prompt, command, opts.engine);
    }, {
      hasSession: tmux.hasSession,
    });
    if (opts.wait) await wakeSession.waitForEngine(`${session}:${mainWindowName}`, getPaneInfos, isAgentCommand);
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${mainWindowName})`);

    if (!opts.noFleet) {
      const fleet = ensureFleetSessionEntry({ session, window: mainWindowName, cwd: repoPath, createdBy: "maw wake" });
      if (fleet.status === "created") {
        console.log(`\x1b[32m+\x1b[0m fleet auto-registered ${session}`);
      }
    }

    // Auto-register agent in config.agents so federation peers can route to it (#285)
    const agents = config.agents || {};
    if (!(oracle in agents)) {
      const node = config.node || "local";
      saveConfig({ agents: { ...agents, [oracle]: node } });
      console.log(`\x1b[32m+\x1b[0m registered agent '${oracle}' → '${node}' in config.agents`);
    }


    await runWakeLifecycleHooks({ oracle, session, repoPath, repoName });

    const initialWindows = await tmux.listWindows(session).catch(() => [] as WakeWindowLookupEntry[]);
    let existingWindows = new Set(initialWindows.map(w => w.name));
    existingWindows.add(mainWindowName);
    if (requestedSnapshotSession) {
      const allWt = await findWorktrees(parentDir, repoName);
      const restored = await restoreSnapshotWindows(
        oracle,
        session,
        requestedSnapshotSession,
        existingWindows,
        allWt,
        repoPath,
        requestedSnapshotFile || "snapshot",
        opts.engine,
      );
      console.log(`\x1b[36m↻\x1b[0m snapshot restore: ${restored} window${restored === 1 ? "" : "s"}`);
    }

    if (!foreignSession && !opts.task && !opts.wt && doRehydrate) {
      const allWt = await findWorktrees(parentDir, repoName);
      const rehydratableWt = await filterMergedWorktreesForRehydrate(allWt, { hostExec, baseBranch: "alpha" });
      const plan = planRehydrateWorktreeWindows(oracle, rehydratableWt, [...existingWindows]);
      logAgentsRehydrationSource(plan.length, allWt);
      const selectedPlan = selectAgentsRehydrationPlan(plan);
      if (plan.length > 0 && selectedPlan.length === 0) {
        console.log(`\x1b[33m⚡\x1b[0m skipped agent rehydration`);
      } else if (selectedPlan.length > 0) {
        console.log(`\x1b[36m↻\x1b[0m rehydrating from agents/ folder:`);
      }
      for (const wt of selectedPlan) {
        await tmux.newWindow(session, wt.windowName, { cwd: wt.path });
        const wtEngine = wakeSession.readWorktreeEngineFile(wt.path);
        const wtOpts = wtEngine ? { ...opts, engine: wtEngine } : opts;
        const target = `${session}:${wt.windowName}`;
        await tmux.sendText(target, await buildWakeCommandForPane(wt.windowName, wt.path, wtOpts, target));
        if (opts.wait) await wakeSession.waitForEngine(target, getPaneInfos, isAgentCommand);
        existingWindows.add(wt.windowName);
        console.log(`\x1b[32m+\x1b[0m window: ${wt.windowName}  \x1b[90m(from ${formatWorktreeSource(wt.path)})\x1b[0m`);
      }
      if (selectedPlan.length > 0) console.log(`\x1b[36m↻\x1b[0m respawned ${selectedPlan.length} worktree window${selectedPlan.length === 1 ? "" : "s"}`);
    }
    knownWindows = existingWindows;
    knownWindowEntries = [...initialWindows, { name: mainWindowName, cwd: repoPath }];
  } else {
    await setSessionEnv(session);
    await runWakeLifecycleHooks({ oracle, session, repoPath, repoName });
    let preExistingWindowEntries: WakeWindowLookupEntry[] = [];
    let preExistingWindows = new Set<string>();
    try {
      preExistingWindowEntries = await tmux.listWindows(session);
      preExistingWindows = new Set(preExistingWindowEntries.map(w => w.name));
    } catch {
      knownWindowsReliable = false;
    }

    if (requestedSnapshotSession) {
      const allWt = await findWorktrees(parentDir, repoName);
      const restored = await restoreSnapshotWindows(
        oracle,
        session,
        requestedSnapshotSession,
        preExistingWindows,
        allWt,
        repoPath,
        requestedSnapshotFile || "snapshot",
        opts.engine,
      );
      console.log(`\x1b[36m↻\x1b[0m snapshot restore: ${restored} window${restored === 1 ? "" : "s"}`);
    }

    if (!foreignSession && !opts.task && !opts.wt && doRehydrate) {
      const allWt = await findWorktrees(parentDir, repoName);
      if (allWt.length > 0) {
        const existingWindows = [...preExistingWindows];
        const liveTileRoles = await getLiveTileRoles(session);
        const rehydratableWt = await filterMergedWorktreesForRehydrate(allWt, { hostExec, baseBranch: "alpha" });
        const plan = planRehydrateWorktreeWindows(oracle, rehydratableWt, existingWindows, liveTileRoles);
        logAgentsRehydrationSource(plan.length, allWt);
        if (plan.length > 0) {
          const selectedPlan = selectAgentsRehydrationPlan(plan);
          if (selectedPlan.length === 0) {
            console.log(`\x1b[33m⚡\x1b[0m skipped agent rehydration`);
          } else {
            console.log(`\x1b[36m↻\x1b[0m rehydrating from agents/ folder:`);
            for (const wt of selectedPlan) {
              await tmux.newWindow(session, wt.windowName, { cwd: wt.path });
              const wtEngine = wakeSession.readWorktreeEngineFile(wt.path);
              const wtOpts = wtEngine ? { ...opts, engine: wtEngine } : opts;
              const target = `${session}:${wt.windowName}`;
              await tmux.sendText(target, await buildWakeCommandForPane(wt.windowName, wt.path, wtOpts, target));
              preExistingWindows.add(wt.windowName);
              preExistingWindowEntries.push({ name: wt.windowName, cwd: wt.path });
              console.log(`\x1b[32m↻\x1b[0m respawned: ${wt.windowName}  \x1b[90m(from ${formatWorktreeSource(wt.path)})\x1b[0m`);
            }
            console.log(`\x1b[36m↻\x1b[0m respawned ${selectedPlan.length} worktree window${selectedPlan.length === 1 ? "" : "s"}`);
          }
        }
      } else {
        logAgentsRehydrationSource(0, allWt);
      }
    }

    await new Promise(r => setTimeout(r, cfgTimeout("wakeVerify")));
    const retried = await wakeSession.ensureSessionRunning(session, preExistingWindows);
    if (retried > 0) console.log(`\x1b[33m${retried} window(s) retried.\x1b[0m`);
    knownWindows = preExistingWindows;
    knownWindowEntries = preExistingWindowEntries;
  }

  const reordered = foreignSession ? 0 : await restoreTabOrder(session);
  if (reordered > 0) console.log(`\x1b[36m↻ ${reordered} window(s) reordered to saved positions.\x1b[0m`);

  let targetPath = repoPath;
  let windowName = mainWindowName;

  if (opts.wt || opts.task) {
    const requestedName = sanitizeBranchName(opts.wt || opts.task!);
    const stableName = opts.name ? sanitizeBranchName(opts.name) : "";
    const name = stableName
      ? sanitizeBranchName(opts.wt && requestedName !== stableName ? `${stableName}-${requestedName}` : stableName)
      : requestedName;
    const worktreeScopeStem = mainWindowName;
    const worktrees = await findWorktrees(parentDir, repoName, opts.fresh ? undefined : name, worktreeScopeStem);
    let match: { path: string; name: string } | null = null;
    if (!opts.fresh) {
      if (opts.pick) {
        const resolvedTarget = resolveWorktreeTarget(name, worktrees);
        const candidates = resolvedTarget.kind === "exact" || resolvedTarget.kind === "fuzzy"
          ? [resolvedTarget.match]
          : resolvedTarget.kind === "ambiguous"
            ? resolvedTarget.candidates
            : [];
        if (candidates.length > 0) {
          const picked = promptAmbiguousWorktreePick(name, candidates);
          if (!picked) throw new Error(`--pick requires an interactive selection for '${name}'`);
          match = picked;
        }
      } else {
        // #1775/#1780 — preserve cross-repo reuse for the target oracle's
        // historical worktrees without allowing another oracle's matching slug
        // to hijack the wake target.
        match = findReusableWorktreeBySlug(parentDir, name, worktreeScopeStem);
        if (!match) {
          const resolvedTarget = resolveWorktreeTarget(name, worktrees);
          switch (resolvedTarget.kind) {
            case "exact":
            case "fuzzy":
              match = resolvedTarget.match;
              break;
            case "ambiguous": {
              // #1768 — show a numbered picker on TTY so users with multiple
              // `<N>-<host>` worktrees can keep working on the right one instead
              // of being forced to retype the exact name. Non-TTY (CI, scripts,
              // redirected stdout) and invalid input fall back to the loud error
              // so automation still fails fast.
              const picked = promptAmbiguousWorktreePick(name, resolvedTarget.candidates);
              if (picked) {
                match = picked;
                break;
              }
              const lines = [
                `\x1b[31m✗\x1b[0m '${name}' is ambiguous — matches ${resolvedTarget.candidates.length} worktrees:`,
                ...resolvedTarget.candidates.map(c => `\x1b[90m    • ${c.name}\x1b[0m`),
                `\x1b[90m  use the full name: maw wake ${oracle} --task <exact-worktree>\x1b[0m`,
              ];
              throw new Error(lines.join("\n"));
            }
            case "none":
              match = null;
              break;
          }
        }
      }
    }

    if (match) {
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      await wakeSession.reconcileParentClaudeDir(repoPath, match.path, console.log.bind(console));
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      const existingTaskWindow = opts.fresh
        ? undefined
        : findExistingWakeWindowEntry(knownWindowEntries, oracle, `${oracle}-${name}`);
      if (existingTaskWindow) {
        console.log(`\x1b[33m⚡\x1b[0m reusing live window: ${session}:${existingTaskWindow.name}`);
        targetPath = existingTaskWindow.cwd || repoPath;
        windowName = existingTaskWindow.name;
      } else {
        const result = await wakeSession.createWorktree(repoPath, parentDir, repoName, oracle, name, worktrees, {
          fresh: !!opts.fresh,
          named: Boolean(stableName && !opts.fresh),
          layout: worktreeLayout,
          existingWindowNames: knownWindows,
          engine: opts.engine || config.defaultEngine || defaultEngineNameForConfig(config),
        });
        targetPath = result.wtPath;
        windowName = result.windowName;
      }
    }

    if (opts.bud) {
      const safePath = targetPath.replace(/'/g, "'\\''");
      const branch = (await hostExec(`git -C '${safePath}' branch --show-current 2>/dev/null || true`)).trim();
      const lineage = {
        parentOracle: oracle,
        task: name,
        branch,
      };
      const lineageFile = writeWakeBudLineage(targetPath, lineage);
      console.log(`\x1b[32m🌱\x1b[0m lineage: ${lineageFile}`);
      if (opts.signalOnBirth) {
        const signalFile = writeWakeBudBirthSignal(repoPath, `${oracle}-${name}`, {
          ...lineage,
          worktreePath: targetPath,
        });
        console.log(`\x1b[36m⬡\x1b[0m signal: ${signalFile}`);
      }
    }
  }

  const registerWorktreeWindow = (fleetWindowName = windowName) => {
    if (opts.noFleet || !(opts.task || opts.wt)) return;
    const fleet = ensureFleetSessionEntry({ session, window: fleetWindowName, cwd: targetPath, createdBy: "maw wake" });
    if (fleet.status === "created" || fleet.status === "updated") {
      console.log(`\x1b[32m+\x1b[0m fleet registered window ${session}:${fleetWindowName}`);
    }
  };

  const existingWindow = findExistingWakeWindow(knownWindows, oracle, windowName);
  if (existingWindow) {
      const target = `${session}:${existingWindow}`;
      registerWorktreeWindow(existingWindow);
      if (opts.prompt) {
        await tmux.selectWindow(target);
        const wakeCommand = buildWakeCommand(existingWindow, targetPath, opts);
        if (opts.engine) {
          if (!(await respawnPaneWithCommand(target, wakeCommand))) {
            await sendWakeCommandAndPrompt(target, opts.prompt, wakeCommand, opts.engine);
          } else {
            await sendPromptViaTmux(target, opts.prompt);
          }
        } else {
          await sendWakeCommandAndPrompt(target, opts.prompt, wakeCommand, opts.engine);
        }
        if (opts.attach) await wakeSession.attachToSession(session);
        await maybeSplit(target, opts);
        await maybeOpenWindow(target, opts);
        await recordWakeSnapshot(opts);
        return target;
      }
      // Check if agent is actually alive in the pane
      const infos = await getPaneInfos([target]);
      const info = infos[target];
      const agentAlive = info && isAgentCommand(info.command);

      if (!agentAlive) {
        console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' in ${session} — agent dead, re-launching fresh...`);
        await tmux.sendText(target, buildWakeCommand(existingWindow, targetPath, { ...opts, freshLaunch: true }));
        if (opts.wait) await wakeSession.waitForEngine(target, getPaneInfos, isAgentCommand);
        if (opts.attach) {
          await tmux.selectWindow(target);
          await wakeSession.attachToSession(session);
        }
        await maybeSplit(target, opts);
        await maybeOpenWindow(target, opts);
        await recordWakeSnapshot(opts);
        return target;
      }

      if (opts.engine) {
        console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' in ${session} — switching engine to ${opts.engine}...`);
        const command = buildWakeCommand(existingWindow, targetPath, opts);
        if (!(await respawnPaneWithCommand(target, command))) {
          await tmux.sendText(target, command);
        }
        if (opts.attach) {
          await tmux.selectWindow(target);
          await wakeSession.attachToSession(session);
        }
        await maybeSplit(target, opts);
        await maybeOpenWindow(target, opts);
        await recordWakeSnapshot(opts);
        return target;
      }

      console.log(`\x1b[32m⚡\x1b[0m '${existingWindow}' running in ${session}`);
      if (shouldOfferExistingSessionAttach(opts)) {
        process.stdout.write(`  attach? [y/N] `);
        const { openSync, readSync, closeSync } = await import("fs");
        try {
          const fd = openSync("/dev/tty", "r");
          const buf = Buffer.alloc(8);
          const n = readSync(fd, buf, 0, buf.length, null);
          closeSync(fd);
          const answer = buf.slice(0, n).toString().trim().toLowerCase();
          if (answer === "y" || answer === "yes") opts.attach = true;
        } catch {}
      }
      if (opts.attach) {
        await tmux.selectWindow(target);
        await wakeSession.attachToSession(session);
      }
      await maybeSplit(target, opts);
      await maybeOpenWindow(target, opts);
      await recordWakeSnapshot(opts);
      return target;
    }

  if (!knownWindowsReliable) {
    throw new Error(`could not list windows for session '${session}' — refusing to create '${windowName}' because it may already exist`);
  }

  // #2 — a new task/worktree window is a net-new agent pane: cap-check before
  // spawning it (no-op when limits.maxConcurrentAgents is explicitly 0).
  await assertAgentCapacity(oracle);

  await tmux.newWindow(session, windowName, { cwd: targetPath });
  registerWorktreeWindow();
  const cmd = buildWakeCommand(windowName, targetPath, opts);
  if (opts.prompt) {
    await sendWakeCommandAndPrompt(`${session}:${windowName}`, opts.prompt, cmd, opts.engine);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  if (opts.attach) await wakeSession.attachToSession(session);

  await maybeSplit(`${session}:${windowName}`, opts);
  await maybeOpenWindow(`${session}:${windowName}`, opts);

  await recordWakeSnapshot(opts);
  return `${session}:${windowName}`;
}
