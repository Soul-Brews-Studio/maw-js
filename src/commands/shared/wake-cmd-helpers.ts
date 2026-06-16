import { writeSignal } from "../../core/fleet/leaf";
import { type Snapshot, type SnapshotSession } from "../../core/fleet/snapshot";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface WakeBudLineageInput {
  parentOracle: string;
  task: string;
  branch?: string;
  buddedAt?: string;
  buddedBy?: string;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function wakeBudActor(): string {
  return process.env.CLAUDE_AGENT_NAME
    || process.env.MAW_ORACLE_NAME
    || process.env.TMUX_PANE
    || process.env.USER
    || "unknown";
}

export function buildWakeBudLineage(input: WakeBudLineageInput): string {
  const rows: [string, string][] = [
    ["budded_from", input.parentOracle],
    ["budded_at", input.buddedAt ?? new Date().toISOString()],
    ["budded_by", input.buddedBy ?? wakeBudActor()],
    ["branch", input.branch ?? ""],
    ["task", input.task],
  ];
  return `${rows.map(([key, value]) => `${key}: ${yamlScalar(value)}`).join("\n")}\n`;
}

export function writeWakeBudLineage(worktreePath: string, input: WakeBudLineageInput): string {
  const psiDir = join(worktreePath, "ψ");
  mkdirSync(psiDir, { recursive: true });
  const file = join(psiDir, ".lineage.yaml");
  writeFileSync(file, buildWakeBudLineage(input), "utf-8");
  return file;
}

export function writeWakeBudBirthSignal(
  parentRoot: string,
  childName: string,
  input: WakeBudLineageInput & { worktreePath: string },
): string {
  return writeSignal(parentRoot, childName, {
    kind: "info",
    message: `wake-bud born: ${childName}`,
    context: {
      buddedFrom: input.parentOracle,
      task: input.task,
      branch: input.branch ?? "",
      worktreePath: input.worktreePath,
    },
  });
}

export interface ExistingSessionAttachOpts {
  attach?: boolean;
  split?: boolean;
  bring?: boolean;
}

export interface WaitForTmuxSessionReadyDeps {
  hasSession?: (session: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
  throwOnTimeout?: boolean;
}

export interface RetryFreshSessionTmuxStepDeps {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
  hasSession?: (session: string) => Promise<boolean>;
}

export function shouldOfferExistingSessionAttach(
  opts: ExistingSessionAttachOpts,
  isTTY = process.stdin.isTTY,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !opts.attach &&
    !opts.split &&
    !opts.bring &&
    Boolean(isTTY) &&
    env.MAW_TEST_MODE !== "1" &&
    env.MAW_ATTACH_FOLLOWS !== "1"
  );
}

const FRESH_SESSION_READY_ATTEMPTS = 10;
const FRESH_SESSION_READY_DELAY_MS = 50;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause ? `${error.message}\n${errorMessage(cause)}` : error.message;
  }
  return String(error);
}

function isFreshSessionLookupRace(error: unknown, session: string): boolean {
  const message = errorMessage(error);
  return message.includes(session) && /can't find (session|window|pane)/i.test(message);
}

export async function waitForTmuxSessionReady(
  session: string,
  deps: WaitForTmuxSessionReadyDeps = {},
): Promise<void> {
  const hasSession = deps.hasSession ?? (async () => false);
  const wait = deps.sleep ?? sleep;
  const attempts = deps.attempts ?? FRESH_SESSION_READY_ATTEMPTS;
  const delayMs = deps.delayMs ?? FRESH_SESSION_READY_DELAY_MS;
  const throwOnTimeout = deps.throwOnTimeout ?? false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await hasSession(session)) return;
    if (attempt < attempts) await wait(delayMs);
  }

  // Best-effort only: a just-created tmux session can be attachable even when
  // external visibility probes lag on loaded tmux servers. Wake should continue
  // to the concrete tmux operation/attach instead of aborting here (#1794).
  if (throwOnTimeout) {
    throw new Error(`tmux did not report fresh session '${session}' ready after ${attempts} checks`);
  }
}

export async function retryFreshSessionTmuxStep<T>(
  session: string,
  label: string,
  step: () => Promise<T>,
  deps: RetryFreshSessionTmuxStepDeps = {},
): Promise<T> {
  const wait = deps.sleep ?? sleep;
  const attempts = deps.attempts ?? FRESH_SESSION_READY_ATTEMPTS;
  const delayMs = deps.delayMs ?? FRESH_SESSION_READY_DELAY_MS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (!isFreshSessionLookupRace(error, session) || attempt === attempts) {
        throw error;
      }
      // Do not gate fresh wake on a separate has-session probe: on loaded
      // tmux servers that external lookup can lag behind the real session,
      // while the next concrete tmux operation (or attach) is the useful
      // source of truth. Sleep briefly, then retry the operation itself.
      await wait(delayMs);
    }
  }

  throw new Error(`unreachable: fresh tmux session setup step '${label}' exhausted without throwing`);
}


export type RehydrateWorktree = { name: string; path: string };

export type RehydrateMergeCheckDeps = {
  hostExec: (command: string) => Promise<string>;
  baseBranch?: string;
};

function shellArg(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function parseMergedBranches(output: string): Set<string> {
  return new Set(
    output
      .split("\n")
      .map(line => line.replace(/^\*?\s*/, "").trim())
      .filter(Boolean),
  );
}

export async function isWorktreeBranchMergedToBase(
  worktree: RehydrateWorktree,
  deps: RehydrateMergeCheckDeps,
): Promise<boolean> {
  const baseBranch = deps.baseBranch ?? "alpha";
  const cwd = shellArg(worktree.path);
  try {
    const branch = (await deps.hostExec(`git -C ${cwd} branch --show-current`)).trim();
    if (!branch) return false;
    const merged = await deps.hostExec(`git -C ${cwd} branch --merged ${shellArg(baseBranch)}`);
    return parseMergedBranches(merged).has(branch);
  } catch {
    // Rehydrate conservatively if Git cannot answer. A stale or missing local
    // alpha ref should not hide a still-active worktree.
    return false;
  }
}

export async function filterMergedWorktreesForRehydrate(
  worktrees: RehydrateWorktree[],
  deps: RehydrateMergeCheckDeps,
): Promise<RehydrateWorktree[]> {
  const kept: RehydrateWorktree[] = [];
  for (const wt of worktrees) {
    if (await isWorktreeBranchMergedToBase(wt, deps)) continue;
    kept.push(wt);
  }
  return kept;
}

export type RehydrateWorktreePlan = {
  worktreeName: string;
  windowName: string;
  path: string;
};

export type SnapshotRestorePlan = {
  windowName: string;
  cwd: string;
  source: "repo" | "worktree";
};

function stripFleetPrefix(name: string): string {
  return name.replace(/^\d+-/, "");
}

export function planRehydrateWorktreeWindows(
  oracle: string,
  worktrees: { name: string; path: string }[],
  existingWindows: string[] = [],
  liveTileRoles: Set<string> = new Set(),
): RehydrateWorktreePlan[] {
  const usedNames = new Set(existingWindows);
  const planned: RehydrateWorktreePlan[] = [];
  const oracleBase = oracle.replace(/^\d+-/, "");
  const oracleBaseLower = oracleBase.toLowerCase();
  for (const wt of worktrees) {
    const taskPart = wt.name.replace(/^\d+-/, "");
    if (taskPart.toLowerCase() === oracleBaseLower) continue;
    const cleanTask = taskPart.toLowerCase().startsWith(`${oracleBaseLower}-`)
      ? taskPart.slice(oracleBase.length + 1)
      : taskPart;
    if (!cleanTask) continue;
    if (liveTileRoles.has(taskPart) || liveTileRoles.has(cleanTask)) continue;
    let wtWindowName = `${oracle}-${cleanTask}`;
    if (usedNames.has(wtWindowName)) {
      if (existingWindows.includes(wtWindowName)) continue;
      const numberPrefix = wt.name.match(/^(\d+)-/)?.[1];
      wtWindowName = `${oracle}-${numberPrefix ? `${numberPrefix}-` : ""}${cleanTask}`;
    }
    const altName = `${oracle}-${wt.name}`;
    if (existingWindows.includes(wtWindowName) || existingWindows.includes(altName)) continue;
    usedNames.add(wtWindowName);
    planned.push({ worktreeName: wt.name, windowName: wtWindowName, path: wt.path });
  }
  return planned;
}

export function findWakeSnapshotSession(
  snapshot: Snapshot,
  oracle: string,
  session?: string | null,
): SnapshotSession | null {
  if (session) {
    const exact = snapshot.sessions.find(s => s.name === session);
    if (exact) return exact;
  }

  const oracleBase = stripFleetPrefix(oracle);
  return snapshot.sessions.find(s => {
    const sessionBase = stripFleetPrefix(s.name);
    return sessionBase === oracleBase
      || s.name === oracleBase
      || s.name.endsWith(`-${oracleBase}`);
  }) ?? null;
}

export function planSnapshotRestoreWindows(
  oracle: string,
  snapshotSession: SnapshotSession,
  existingWindows: Iterable<string>,
  worktrees: { name: string; path: string }[],
  repoPath: string,
): SnapshotRestorePlan[] {
  const existing = new Set(existingWindows);
  const planned: SnapshotRestorePlan[] = [];
  const seen = new Set<string>();

  for (const win of snapshotSession.windows) {
    const windowName = win.name?.trim();
    if (!windowName || existing.has(windowName) || seen.has(windowName)) continue;
    seen.add(windowName);

    let cwd = repoPath;
    let source: SnapshotRestorePlan["source"] = "repo";
    const prefix = `${oracle}-`;
    if (windowName.startsWith(prefix)) {
      const suffix = windowName.slice(prefix.length);
      const wt = worktrees.find(w =>
        w.name === suffix
        || stripFleetPrefix(w.name) === suffix
        || `${oracle}-${w.name}` === windowName
        || `${oracle}-${stripFleetPrefix(w.name)}` === windowName
      );
      if (wt) {
        cwd = wt.path;
        source = "worktree";
      }
    }

    planned.push({ windowName, cwd, source });
  }

  return planned;
}
