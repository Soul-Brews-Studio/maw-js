import { hostExec, tmux, restoreTabOrder, takeSnapshot, getPaneInfos, isAgentCommand } from "../../sdk";
import { ghqFind } from "../../core/ghq";
import { buildCommandInDir, cfgTimeout, loadConfig, saveConfig } from "../../config";
import { resolveWorktreeTarget } from "../../core/matcher/resolve-target";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { assertValidOracleName } from "../../core/fleet/validate";
import { resolveOracle, findWorktrees, getSessionMap, resolveFleetSession, detectSession, setSessionEnv, sanitizeBranchName } from "./wake-resolve";
import { attachToSession, ensureSessionRunning, createWorktree } from "./wake-session";
import { maybeOpenWindow, maybeSplit } from "./wake-maybe-split";
import { runWakeLifecycleHooks } from "../../plugin/lifecycle";
import { parseWakeTarget, ensureCloned } from "./wake-target";
import { assertAgentCapacity } from "./wake-concurrency";
import { writeSignal } from "../../core/fleet/leaf";
import { latestSnapshot, loadSnapshot, type Snapshot, type SnapshotSession } from "../../core/fleet/snapshot";
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

export function shouldOfferExistingSessionAttach(
  opts: { attach?: boolean; split?: boolean; bring?: boolean },
  isTTY = process.stdin.isTTY,
): boolean {
  return !opts.attach && !opts.split && !opts.bring && Boolean(isTTY);
}

const FRESH_SESSION_READY_ATTEMPTS = 8;
const FRESH_SESSION_READY_DELAY_MS = 150;

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

async function recordWakeSnapshot(): Promise<void> {
  try {
    await takeSnapshot("wake");
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

export async function waitForTmuxSessionReady(
  session: string,
  deps: {
    hasSession?: (session: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    delayMs?: number;
  } = {},
): Promise<void> {
  const hasSession = deps.hasSession ?? tmux.hasSession.bind(tmux);
  const wait = deps.sleep ?? sleep;
  const attempts = deps.attempts ?? FRESH_SESSION_READY_ATTEMPTS;
  const delayMs = deps.delayMs ?? FRESH_SESSION_READY_DELAY_MS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await hasSession(session)) return;
    if (attempt < attempts) await wait(delayMs);
  }

  throw new Error(`tmux did not report fresh session '${session}' ready after ${attempts} checks`);
}

export async function retryFreshSessionTmuxStep<T>(
  session: string,
  label: string,
  step: () => Promise<T>,
  deps: {
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    delayMs?: number;
    hasSession?: (session: string) => Promise<boolean>;
  } = {},
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
      await wait(delayMs);
      await waitForTmuxSessionReady(session, {
        hasSession: deps.hasSession,
        sleep: wait,
        attempts: 2,
        delayMs,
      });
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

export interface WakeOptions {
  task?: string;
  wt?: string;
  prompt?: string;
  /** Target an existing foreign tmux workspace session instead of the oracle's own session (#1616). */
  session?: string;
  incubate?: string;
  fresh?: boolean;
  attach?: boolean;
  listWt?: boolean;
  dryRun?: boolean;
  noRehydrate?: boolean;
  split?: boolean;
  bring?: boolean;
  tab?: boolean;
  bud?: boolean;
  signalOnBirth?: boolean;
  repoPath?: string;
  urlRepoName?: string;
  allLocal?: boolean;
  engine?: string;
  fromSnapshot?: boolean;
  snapshotId?: string;
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
    // #1445 — tile panes are split panes (role metadata), not windows.
    // If the role is already alive in-session, skip respawn.
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

function stripFleetPrefix(name: string): string {
  return name.replace(/^\d+-/, "");
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

function loadRequestedSnapshot(snapshotId?: string): Snapshot | null {
  return snapshotId ? loadSnapshot(snapshotId) : latestSnapshot();
}

async function restoreSnapshotWindows(
  oracle: string,
  session: string,
  snapshotSession: SnapshotSession,
  existingWindows: Set<string>,
  worktrees: { name: string; path: string }[],
  repoPath: string,
  engine?: string,
): Promise<number> {
  const planned = planSnapshotRestoreWindows(oracle, snapshotSession, existingWindows, worktrees, repoPath);
  for (const win of planned) {
    await tmux.newWindow(session, win.windowName, { cwd: win.cwd });
    await new Promise(r => setTimeout(r, 300));
    await tmux.sendText(`${session}:${win.windowName}`, buildCommandInDir(win.windowName, win.cwd, engine));
    existingWindows.add(win.windowName);
    const label = win.source === "worktree" ? "worktree" : "repo";
    console.log(`\x1b[36m↻\x1b[0m snapshot window: ${win.windowName}  \x1b[90m${label}: ${win.cwd}\x1b[0m`);
  }
  return planned.length;
}


function validateForeignSessionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new Error(`invalid target session '${name}' — use letters, numbers, dot, underscore, or dash`);
  }
}

async function chooseWakeSessionName(oracle: string, urlRepoName?: string): Promise<string> {
  const baseName = getSessionMap()[oracle] || resolveFleetSession(oracle) || urlRepoName || oracle;
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

function findExistingWakeWindow(windowNames: Iterable<string>, oracle: string, windowName: string): string | undefined {
  const names = [...windowNames];
  const nameSuffix = windowName.replace(`${oracle}-`, "");
  return names.find(w => w === windowName)
    || names.find(w => new RegExp(`^${oracle}-\\d+-${nameSuffix}$`).test(w));
}

export async function cmdWake(oracle: string, opts: WakeOptions): Promise<string> {
  // Canonicalize the bare name before any lookup — strips trailing `/`, `/.git`, `/.git/`
  // so `maw wake token-oracle/` (tab-completion artifact) resolves the same as `token-oracle`.
  oracle = normalizeTarget(oracle);

  const parsed = parseWakeTarget(oracle);
  let parsedRepoPath: string | null = null;
  if (parsed) {
    await ensureCloned(parsed.slug);
    // #1635 — full org/repo input is an explicit disambiguation. Preserve the
    // exact cloned/local slug instead of later resolving the bare oracle name
    // through `ghqFind(/repo)`, which can silently pick a different org.
    parsedRepoPath = await ghqFind(`/${parsed.slug}`);
    oracle = parsed.oracle;
    if (!opts.urlRepoName) opts.urlRepoName = parsed.slug.split("/").pop();
  }

  // #358 — reject -view suffix at the user-input boundary (before any session work).
  assertValidOracleName(oracle);
  let preResolvedSession: string | null = null;
  const numericFleetTarget = oracle.match(/^\d+-(.+)$/);
  if (numericFleetTarget) {
    // #1469 — a user may pass the exact live tmux session (`48-foo`) to
    // bring/split. Prefer that exact session before resolving a repo; then
    // strip the fleet prefix only for repo/oracle lookup (`foo-oracle`).
    const sessions = await tmux.listSessions().catch(() => [] as { name: string }[]);
    if (sessions.some(s => s.name === oracle)) {
      preResolvedSession = oracle;
      oracle = numericFleetTarget[1]!;
    }
  }
  console.log(`\x1b[36m⚡\x1b[0m resolving ${oracle}...`);
  let resolved: { repoPath: string; repoName: string; parentDir: string };

  if (opts.repoPath) {
    // #421 — caller already knows the exact on-disk path (e.g. `maw bud --org`
    // just cloned it). Skip resolveOracle so a stale same-named repo in a
    // different org can't shadow the freshly-created one.
    const repoPath = opts.repoPath;
    resolved = { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
  } else if (parsedRepoPath) {
    const repoPath = parsedRepoPath;
    resolved = { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
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
    resolved = await resolveOracle(oracle, { allLocal: opts.allLocal });
  }

  const { repoPath, repoName, parentDir } = resolved;

  if (opts.bud && !opts.task && !opts.wt) {
    throw new Error("--bud requires --task <slug> or --wt <slug>");
  }

  if (opts.signalOnBirth && !opts.bud) {
    throw new Error("--signal-on-birth requires --bud");
  }

  // #997 — when fuzzy match resolved a different repo (e.g. "v3" → "arra-oracle-v3-oracle"),
  // update oracle to the resolved name so session/window names are correct.
  const resolvedOracle = repoName.replace(/-oracle$/, "");
  if (resolvedOracle !== oracle && repoName.endsWith("-oracle")) {
    oracle = resolvedOracle;
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
      console.log(`\n\x1b[36mWorktrees for ${oracle}\x1b[0m (${worktrees.length})\n`);
      for (const wt of worktrees) console.log(`  \x1b[32m●\x1b[0m ${wt.name}  \x1b[90m${wt.path}\x1b[0m`);
    }
    return `${oracle}:list`;
  }

  const foreignSession = opts.session?.trim();
  if (foreignSession) validateForeignSessionName(foreignSession);
  let session = foreignSession || preResolvedSession || await detectSession(oracle, opts.urlRepoName);
  if (foreignSession) {
    const exists = opts.dryRun || await tmux.hasSession(foreignSession);
    if (!exists) {
      throw new Error(`target session '${foreignSession}' not found — run: maw new ${foreignSession}`);
    }
    console.log(`\x1b[36m→\x1b[0m target workspace session: ${foreignSession}`);
  } else if (session) console.log(`\x1b[36m→\x1b[0m session exists: ${session}`);
  else console.log(`\x1b[36m→\x1b[0m no session found, creating...`);

  const requestedSnapshot = opts.fromSnapshot ? loadRequestedSnapshot(opts.snapshotId) : null;
  if (opts.fromSnapshot && !requestedSnapshot) {
    throw new Error(opts.snapshotId ? `snapshot not found: ${opts.snapshotId}` : "no snapshot found");
  }
  const requestedSnapshotSession = requestedSnapshot ? findWakeSnapshotSession(requestedSnapshot, oracle, session) : null;
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

  const mainWindowName = foreignSession ? oracle : `${oracle}-oracle`;

  if (opts.dryRun) {
    console.log(`\x1b[90mdry-run — no tmux sessions/windows will be changed\x1b[0m`);
    if (foreignSession) {
      console.log(`\x1b[32m+\x1b[0m would wake window '${mainWindowName}' in workspace session '${foreignSession}'`);
    } else if (!session && wakeDecision.wake) {
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
      } else {
        for (const win of planned) console.log(`\x1b[36m↻\x1b[0m would restore snapshot window: ${win.windowName}  \x1b[90m${win.cwd}\x1b[0m`);
      }
    }

    if (opts.noRehydrate || foreignSession) {
      const reason = foreignSession ? "foreign workspace session" : "--main/--solo/--no-rehydrate";
      console.log(`\x1b[90m↻ worktree rehydrate skipped (${reason})\x1b[0m`);
      return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
    }

    const liveTileRoles = session ? await getLiveTileRoles(session) : new Set<string>();
    const planned = planRehydrateWorktreeWindows(oracle, allWt, existingWindows, liveTileRoles);
    if (planned.length === 0) {
      console.log(`\x1b[90m↻ would respawn: none\x1b[0m`);
    } else {
      for (const wt of planned) console.log(`\x1b[32m↻\x1b[0m would respawn: ${wt.windowName}  \x1b[90m${wt.path}\x1b[0m`);
    }
    return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
  }

  let knownWindows = new Set<string>();
  let knownWindowsReliable = true;

  if (!session && wakeDecision.wake) {
    // #2 — refuse to spawn a brand-new session/agent once the fleet is at the
    // configured concurrency cap (no-op when limits.maxConcurrentAgents is 0).
    await assertAgentCapacity(oracle);

    // #769 — URL input names the new session after the full repo (e.g.
    // "m5-oracle") so it's distinct from any unrelated sub-token sessions
    // and immediately disambiguates future `maw wake` calls.
    session = await chooseWakeSessionName(oracle, opts.urlRepoName);
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await waitForTmuxSessionReady(session);
    await retryFreshSessionTmuxStep(session, "set session environment", () => setSessionEnv(session));
    await new Promise(r => setTimeout(r, 300));
    await retryFreshSessionTmuxStep(session, "launch main window", () =>
      tmux.sendText(`${session}:${mainWindowName}`, buildCommandInDir(mainWindowName, repoPath, opts.engine))
    );
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${mainWindowName})`);

    // Auto-register agent in config.agents so federation peers can route to it (#285)
    const config = loadConfig();
    const agents = config.agents || {};
    if (!(oracle in agents)) {
      const node = config.node || "local";
      saveConfig({ agents: { ...agents, [oracle]: node } });
      console.log(`\x1b[32m+\x1b[0m registered agent '${oracle}' → '${node}' in config.agents`);
    }

    // #1020 — session = team: auto-create team config so `maw team spawn`
    // works without explicit `maw team create`.
    const { ensureTeamConfig } = await import("../plugins/team/ensure-config");
    if (ensureTeamConfig(oracle)) {
      console.log(`\x1b[32m+\x1b[0m team '${oracle}' auto-created`);
    }

    await runWakeLifecycleHooks({ oracle, session, repoPath, repoName });

    let existingWindows = new Set((await tmux.listWindows(session).catch(() => [] as { name: string }[])).map(w => w.name));
    existingWindows.add(mainWindowName);
    if (requestedSnapshotSession) {
      const allWt = await findWorktrees(parentDir, repoName);
      const restored = await restoreSnapshotWindows(oracle, session, requestedSnapshotSession, existingWindows, allWt, repoPath, opts.engine);
      console.log(`\x1b[36m↻\x1b[0m snapshot restore: ${restored} window${restored === 1 ? "" : "s"}`);
    }

    if (!foreignSession && !opts.task && !opts.wt && !opts.noRehydrate) {
      const allWt = await findWorktrees(parentDir, repoName);
      for (const wt of planRehydrateWorktreeWindows(oracle, allWt, [...existingWindows])) {
        await tmux.newWindow(session, wt.windowName, { cwd: wt.path });
        await new Promise(r => setTimeout(r, 300));
        await tmux.sendText(`${session}:${wt.windowName}`, buildCommandInDir(wt.windowName, wt.path, opts.engine));
        existingWindows.add(wt.windowName);
        console.log(`\x1b[32m+\x1b[0m window: ${wt.windowName}`);
      }
    }
    knownWindows = existingWindows;
  } else {
    await setSessionEnv(session);
    await runWakeLifecycleHooks({ oracle, session, repoPath, repoName });
    let preExistingWindows = new Set<string>();
    try {
      preExistingWindows = new Set((await tmux.listWindows(session)).map(w => w.name));
    } catch {
      knownWindowsReliable = false;
    }

    if (requestedSnapshotSession) {
      const allWt = await findWorktrees(parentDir, repoName);
      const restored = await restoreSnapshotWindows(oracle, session, requestedSnapshotSession, preExistingWindows, allWt, repoPath, opts.engine);
      console.log(`\x1b[36m↻\x1b[0m snapshot restore: ${restored} window${restored === 1 ? "" : "s"}`);
    }

    if (!foreignSession && !opts.task && !opts.wt && !opts.noRehydrate) {
      const allWt = await findWorktrees(parentDir, repoName);
      if (allWt.length > 0) {
        const existingWindows = [...preExistingWindows];
        const liveTileRoles = await getLiveTileRoles(session);
        for (const wt of planRehydrateWorktreeWindows(oracle, allWt, existingWindows, liveTileRoles)) {
          await tmux.newWindow(session, wt.windowName, { cwd: wt.path });
          await new Promise(r => setTimeout(r, 300));
          await tmux.sendText(`${session}:${wt.windowName}`, buildCommandInDir(wt.windowName, wt.path, opts.engine));
          preExistingWindows.add(wt.windowName);
          console.log(`\x1b[32m↻\x1b[0m respawned: ${wt.windowName}`);
        }
      }
    }

    await new Promise(r => setTimeout(r, cfgTimeout("wakeVerify")));
    const retried = await ensureSessionRunning(session, preExistingWindows);
    if (retried > 0) console.log(`\x1b[33m${retried} window(s) retried.\x1b[0m`);
    knownWindows = preExistingWindows;
  }

  const reordered = foreignSession ? 0 : await restoreTabOrder(session);
  if (reordered > 0) console.log(`\x1b[36m↻ ${reordered} window(s) reordered to saved positions.\x1b[0m`);

  let targetPath = repoPath;
  let windowName = mainWindowName;

  if (opts.wt || opts.task) {
    const name = sanitizeBranchName(opts.wt || opts.task!);
    const worktrees = await findWorktrees(parentDir, repoName);
    let match: { path: string; name: string } | null = null;
    if (!opts.fresh) {
      const resolvedTarget = resolveWorktreeTarget(name, worktrees);
      switch (resolvedTarget.kind) {
        case "exact":
        case "fuzzy":
          match = resolvedTarget.match;
          break;
        case "ambiguous": {
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

    if (match) {
      console.log(`\x1b[33m⚡\x1b[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, worktrees, { fresh: !!opts.fresh });
      targetPath = result.wtPath;
      windowName = result.windowName;
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

  const existingWindow = findExistingWakeWindow(knownWindows, oracle, windowName);
  if (existingWindow) {
      if (opts.prompt) {
        await tmux.selectWindow(`${session}:${existingWindow}`);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        await tmux.sendText(`${session}:${existingWindow}`, `${buildCommandInDir(existingWindow, targetPath, opts.engine)} -p '${escaped}'`);
        if (opts.attach) await attachToSession(session);
        await maybeSplit(`${session}:${existingWindow}`, opts);
        await maybeOpenWindow(`${session}:${existingWindow}`, opts);
        await recordWakeSnapshot();
        return `${session}:${existingWindow}`;
      }
      // Check if agent is actually alive in the pane
      const target = `${session}:${existingWindow}`;
      const infos = await getPaneInfos([target]);
      const info = infos[target];
      const agentAlive = info && isAgentCommand(info.command);

      if (!agentAlive) {
        console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' in ${session} — agent dead, re-launching...`);
        await tmux.sendText(target, buildCommandInDir(existingWindow, targetPath, opts.engine));
        if (opts.attach) {
          await tmux.selectWindow(target);
          await attachToSession(session);
        }
        await maybeSplit(target, opts);
        await maybeOpenWindow(target, opts);
        await recordWakeSnapshot();
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
        await attachToSession(session);
      }
      await maybeSplit(target, opts);
      await maybeOpenWindow(target, opts);
      await recordWakeSnapshot();
      return target;
    }

  if (!knownWindowsReliable) {
    throw new Error(`could not list windows for session '${session}' — refusing to create '${windowName}' because it may already exist`);
  }

  // #2 — a new task/worktree window is a net-new agent pane: cap-check before
  // spawning it (no-op when limits.maxConcurrentAgents is 0).
  await assertAgentCapacity(oracle);

  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  const cmd = buildCommandInDir(windowName, targetPath, opts.engine);
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await tmux.sendText(`${session}:${windowName}`, `${cmd} -p '${escaped}'`);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  if (opts.attach) await attachToSession(session);

  await maybeSplit(`${session}:${windowName}`, opts);
  await maybeOpenWindow(`${session}:${windowName}`, opts);

  await recordWakeSnapshot();
  return `${session}:${windowName}`;
}
