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
  return !opts.attach && !opts.split && !opts.bring && Boolean(isTTY) && env.MAW_TEST_MODE !== "1";
}

const FRESH_SESSION_READY_ATTEMPTS = 120;
const FRESH_SESSION_READY_DELAY_MS = 250;

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
  for (const wt of worktrees) {
    const taskPart = wt.name.replace(/^\d+-/, "");
    if (liveTileRoles.has(taskPart)) continue;
    let wtWindowName = `${oracle}-${taskPart}`;
    if (usedNames.has(wtWindowName)) {
      if (existingWindows.includes(wtWindowName)) continue;
      wtWindowName = `${oracle}-${wt.name}`;
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
