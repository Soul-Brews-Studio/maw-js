import { hostExec, tmux, restoreTabOrder, takeSnapshot, getPaneInfos, isAgentCommand } from "../../sdk";
import { resolve } from "path";
import { ghqFind } from "../../core/ghq";
import { buildCommandInDir, cfgTimeout, loadConfig, saveConfig } from "../../config";
import { resolveWorktreeTarget } from "../../core/matcher/resolve-target";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { assertValidOracleName } from "../../core/fleet/validate";
import { canonicalSessionName } from "../../core/fleet/session-name";
import { resolveOracle, findWorktrees, findReusableWorktreeBySlug, getSessionMap, resolveFleetSession, detectSession, setSessionEnv, sanitizeBranchName } from "./wake-resolve";
import { attachToSession, ensureSessionRunning, createWorktree } from "./wake-session";
import { maybeOpenWindow, maybeSplit } from "./wake-maybe-split";
import { runWakeLifecycleHooks } from "../../plugin/lifecycle";
import { parseWakeTarget, ensureCloned } from "./wake-target";
import { assertAgentCapacity } from "./wake-concurrency";
import { latestSnapshot, loadSnapshot, type Snapshot, type SnapshotSession } from "../../core/fleet/snapshot";
import { listClaudeSessions, type ClaudeSession } from "../../core/fleet/claude-sessions";
import { UserError } from "../../core/util/user-error";
import {
  type RehydrateWorktreePlan,
  type SnapshotRestorePlan,
  findWakeSnapshotSession,
  planRehydrateWorktreeWindows,
  planSnapshotRestoreWindows,
  retryFreshSessionTmuxStep,
  shouldOfferExistingSessionAttach,
  writeWakeBudBirthSignal,
  writeWakeBudLineage,
} from "./wake-cmd-helpers";
export {
  type RehydrateWorktreePlan,
  type SnapshotRestorePlan,
  type WakeBudLineageInput,
  buildWakeBudLineage,
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

function stripOracleRepoSuffix(name: string): string | null {
  return name.toLowerCase().endsWith("-oracle") ? name.slice(0, -"-oracle".length) : null;
}

function bringCwdMetadata(cwd: string | undefined): { oracle?: string; worktree?: string } {
  for (const part of (cwd ? resolve(cwd).split(/[\\/]+/).reverse() : [])) {
    const worktreeMarker = part.indexOf(".wt-");
    if (worktreeMarker > 0) {
      const oracle = stripOracleRepoSuffix(part.slice(0, worktreeMarker)) ?? undefined;
      return { oracle, worktree: part.slice(worktreeMarker + ".wt-".length) || undefined };
    }
    const oracle = stripOracleRepoSuffix(part);
    if (oracle) return { oracle };
  }
  return {};
}

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
  fromSnapshot?: boolean;
  snapshotId?: string;
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
  if (matches.length > 1) throw buildAmbiguousBringDestinationError(source, destination, matches);

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

async function chooseWakeSessionName(oracle: string, urlRepoName?: string): Promise<string> {
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
  await normalizeBringDestinationWindow(oracle, opts);
  const requestedForeignSession = opts.session?.trim();
  if (requestedForeignSession) validateForeignSessionName(requestedForeignSession);

  console.log(`\x1b[36m⚡\x1b[0m resolving ${oracle}...`);

  const existingWindowBringTarget = await resolveExistingWindowBringTarget(oracle, opts, preResolvedSession);
  if (existingWindowBringTarget) {
    console.log(`\x1b[36m→\x1b[0m live tmux window: ${existingWindowBringTarget}`);
    if (opts.dryRun) {
      console.log(`\x1b[90mdry-run — no tmux sessions/windows will be changed\x1b[0m`);
      return existingWindowBringTarget;
    }
    await maybeSplit(existingWindowBringTarget, opts);
    await recordWakeSnapshot();
    return existingWindowBringTarget;
  }

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
      const sessionSummaries = await worktreeSessionSummaries(worktrees);
      console.log(`\n\x1b[36mWorktrees for ${oracle}\x1b[0m (${worktrees.length})\n`);
      for (const wt of worktrees) {
        const summary = formatWorktreeSessionSummary(sessionSummaries.get(wt.name));
        console.log(`  \x1b[32m●\x1b[0m ${wt.name}  \x1b[90m${wt.path}\x1b[0m${summary}`);
      }
    }
    return `${oracle}:list`;
  }

  const foreignSession = requestedForeignSession;
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
    await retryFreshSessionTmuxStep(session, "set session environment", () => setSessionEnv(session), {
      hasSession: tmux.hasSession,
    });
    await new Promise(r => setTimeout(r, 300));
    await retryFreshSessionTmuxStep(session, "launch main window", () =>
      tmux.sendText(`${session}:${mainWindowName}`, buildCommandInDir(mainWindowName, repoPath, opts.engine))
    , {
      hasSession: tmux.hasSession,
    });
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
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, worktrees, {
        fresh: !!opts.fresh,
        named: Boolean(stableName && !opts.fresh),
      });
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
      const target = `${session}:${existingWindow}`;
      if (opts.prompt) {
        await tmux.selectWindow(target);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        const promptCommand = `${buildCommandInDir(existingWindow, targetPath, opts.engine)} -p '${escaped}'`;
        if (opts.engine) {
          if (!(await respawnPaneWithCommand(target, promptCommand))) {
            await tmux.sendText(target, promptCommand);
          }
        } else {
          await tmux.sendText(target, promptCommand);
        }
        if (opts.attach) await attachToSession(session);
        await maybeSplit(target, opts);
        await maybeOpenWindow(target, opts);
        await recordWakeSnapshot();
        return target;
      }
      // Check if agent is actually alive in the pane
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

      if (opts.engine) {
        console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' in ${session} — switching engine to ${opts.engine}...`);
        const command = buildCommandInDir(existingWindow, targetPath, opts.engine);
        if (!(await respawnPaneWithCommand(target, command))) {
          await tmux.sendText(target, command);
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
