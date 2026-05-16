import { hostExec, tmux, restoreTabOrder, takeSnapshot, getPaneInfos, isAgentCommand } from "../../sdk";
import { ghqFind } from "../../core/ghq";
import { buildCommandInDir, cfgTimeout, loadConfig, saveConfig } from "../../config";
import { resolveWorktreeTarget } from "../../core/matcher/resolve-target";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { assertValidOracleName } from "../../core/fleet/validate";
import { resolveOracle, findWorktrees, getSessionMap, resolveFleetSession, detectSession, setSessionEnv, sanitizeBranchName } from "./wake-resolve";
import { attachToSession, ensureSessionRunning, createWorktree } from "./wake-session";
import { maybeOpenWindow, maybeSplit } from "./wake-maybe-split";
import { parseWakeTarget, ensureCloned } from "./wake-target";
import { assertAgentCapacity } from "./wake-concurrency";

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

export async function cmdWake(oracle: string, opts: { task?: string; wt?: string; prompt?: string; incubate?: string; fresh?: boolean; attach?: boolean; listWt?: boolean; dryRun?: boolean; noRehydrate?: boolean; split?: boolean; bring?: boolean; tab?: boolean; repoPath?: string; urlRepoName?: string; allLocal?: boolean; engine?: string }): Promise<string> {
  // Canonicalize the bare name before any lookup — strips trailing `/`, `/.git`, `/.git/`
  // so `maw wake token-oracle/` (tab-completion artifact) resolves the same as `token-oracle`.
  oracle = normalizeTarget(oracle);

  const parsed = parseWakeTarget(oracle);
  if (parsed) {
    await ensureCloned(parsed.slug);
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

  let session = preResolvedSession ?? await detectSession(oracle, opts.urlRepoName);
  if (session) console.log(`\x1b[36m→\x1b[0m session exists: ${session}`);
  else console.log(`\x1b[36m→\x1b[0m no session found, creating...`);

  // #835 — consult unified shouldAutoWake. cmdWake is idempotent: if the
  // session already exists, the helper returns wake=false and we skip the
  // session-create branch (we still proceed to attach/select-window below).
  // This makes the "wakes if missing" decision explicit + auditable.
  const { shouldAutoWake } = await import("./should-auto-wake");
  const wakeDecision = shouldAutoWake(oracle, {
    site: "wake-cmd",
    isLive: Boolean(session),
  });

  const mainWindowName = `${oracle}-oracle`;

  if (opts.dryRun) {
    console.log(`\x1b[90mdry-run — no tmux sessions/windows will be changed\x1b[0m`);
    if (!session && wakeDecision.wake) {
      const plannedSession = await chooseWakeSessionName(oracle, opts.urlRepoName);
      console.log(`\x1b[32m+\x1b[0m would create session '${plannedSession}' (main: ${mainWindowName})`);
    } else if (session) {
      console.log(`\x1b[36m→\x1b[0m would reuse session: ${session}`);
    }

    if (opts.task || opts.wt) {
      console.log(`\x1b[33m⚡\x1b[0m would wake worktree/task: ${sanitizeBranchName(opts.wt || opts.task!)}`);
      return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
    }

    if (opts.noRehydrate) {
      console.log(`\x1b[90m↻ worktree rehydrate skipped (--main/--solo/--no-rehydrate)\x1b[0m`);
      return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
    }

    const allWt = await findWorktrees(parentDir, repoName);
    const existingWindows = session
      ? (await tmux.listWindows(session).catch(() => [] as { name: string }[])).map(w => w.name)
      : [];
    const liveTileRoles = session ? await getLiveTileRoles(session) : new Set<string>();
    const planned = planRehydrateWorktreeWindows(oracle, allWt, existingWindows, liveTileRoles);
    if (planned.length === 0) {
      console.log(`\x1b[90m↻ would respawn: none\x1b[0m`);
    } else {
      for (const wt of planned) console.log(`\x1b[32m↻\x1b[0m would respawn: ${wt.windowName}  \x1b[90m${wt.path}\x1b[0m`);
    }
    return session ? `${session}:${mainWindowName}` : `${oracle}:dry-run`;
  }

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

    if (!opts.task && !opts.wt && !opts.noRehydrate) {
      const allWt = await findWorktrees(parentDir, repoName);
      for (const wt of planRehydrateWorktreeWindows(oracle, allWt)) {
        await tmux.newWindow(session, wt.windowName, { cwd: wt.path });
        await new Promise(r => setTimeout(r, 300));
        await tmux.sendText(`${session}:${wt.windowName}`, buildCommandInDir(wt.windowName, wt.path, opts.engine));
        console.log(`\x1b[32m+\x1b[0m window: ${wt.windowName}`);
      }
    }
  } else {
    await setSessionEnv(session);
    let preExistingWindows = new Set<string>();
    try { preExistingWindows = new Set((await tmux.listWindows(session)).map(w => w.name)); } catch { /* ok */ }

    if (!opts.task && !opts.wt && !opts.noRehydrate) {
      const allWt = await findWorktrees(parentDir, repoName);
      if (allWt.length > 0) {
        const existingWindows = [...preExistingWindows];
        const liveTileRoles = await getLiveTileRoles(session);
        for (const wt of planRehydrateWorktreeWindows(oracle, allWt, existingWindows, liveTileRoles)) {
          await tmux.newWindow(session, wt.windowName, { cwd: wt.path });
          await new Promise(r => setTimeout(r, 300));
          await tmux.sendText(`${session}:${wt.windowName}`, buildCommandInDir(wt.windowName, wt.path, opts.engine));
          console.log(`\x1b[32m↻\x1b[0m respawned: ${wt.windowName}`);
        }
      }
    }

    await new Promise(r => setTimeout(r, cfgTimeout("wakeVerify")));
    const retried = await ensureSessionRunning(session, preExistingWindows);
    if (retried > 0) console.log(`\x1b[33m${retried} window(s) retried.\x1b[0m`);
  }

  const reordered = await restoreTabOrder(session);
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
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, worktrees);
      targetPath = result.wtPath;
      windowName = result.windowName;
    }
  }

  try {
    const windows = await tmux.listWindows(session);
    const nameSuffix = windowName.replace(`${oracle}-`, "");
    const existingWindow = windows.map(w => w.name).find(w => w === windowName)
      || windows.map(w => w.name).find(w => new RegExp(`^${oracle}-\\d+-${nameSuffix}$`).test(w));
    if (existingWindow) {
      if (opts.prompt) {
        await tmux.selectWindow(`${session}:${existingWindow}`);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        await tmux.sendText(`${session}:${existingWindow}`, `${buildCommandInDir(existingWindow, targetPath, opts.engine)} -p '${escaped}'`);
        if (opts.attach) await attachToSession(session);
        await maybeSplit(`${session}:${existingWindow}`, opts);
        await maybeOpenWindow(`${session}:${existingWindow}`, opts);
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
      return target;
    }
  } catch { /* session might be fresh */ }

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

  takeSnapshot("wake").catch(() => {});
  return `${session}:${windowName}`;
}
