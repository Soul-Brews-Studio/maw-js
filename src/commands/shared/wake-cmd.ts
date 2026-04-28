import { hostExec, tmux, restoreTabOrder, takeSnapshot } from "../../sdk";
import { ghqFind } from "../../core/ghq";
import { buildCommandInDir, cfgTimeout, loadConfig, saveConfig } from "../../config";
import { resolveWorktreeTarget } from "../../core/matcher/resolve-target";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { assertValidOracleName } from "../../core/fleet/validate";
import { resolveOracle, findWorktrees, getSessionMap, resolveFleetSession, detectSession, setSessionEnv, sanitizeBranchName } from "./wake-resolve";
import { attachToSession, ensureSessionRunning, createWorktree } from "./wake-session";
import { maybeSplit } from "./wake-maybe-split";

export async function cmdWake(oracle: string, opts: { task?: string; wt?: string; prompt?: string; incubate?: string; fresh?: boolean; attach?: boolean; listWt?: boolean; split?: boolean; repoPath?: string; urlRepoName?: string; allLocal?: boolean }): Promise<string> {
  // Canonicalize the bare name before any lookup — strips trailing `/`, `/.git`, `/.git/`
  // so `maw wake token-oracle/` (tab-completion artifact) resolves the same as `token-oracle`.
  oracle = normalizeTarget(oracle);
  // #358 — reject -view suffix at the user-input boundary (before any session work).
  assertValidOracleName(oracle);
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
  // #673 — extract org/repo slug from ghq path (…/github.com/<org>/<repo>)
  const ghSlug = repoPath.includes("github.com/")
    ? repoPath.slice(repoPath.indexOf("github.com/") + "github.com/".length)
    : repoName;
  console.log(`\x1b[36m→\x1b[0m found \x1b[1m${ghSlug}\x1b[0m (${repoPath})`);
  let session = await detectSession(oracle, opts.urlRepoName);
  if (session) console.log(`\x1b[36m→\x1b[0m session exists: ${session}`);
  else console.log(`\x1b[36m→\x1b[0m no session found, creating...`);

  if (!session) {
    // #769 — URL input names the new session after the full repo (e.g.
    // "m5-oracle") so it's distinct from any unrelated sub-token sessions
    // and immediately disambiguates future `maw wake` calls.
    session = getSessionMap()[oracle] || resolveFleetSession(oracle) || opts.urlRepoName || oracle;
    const mainWindowName = `${oracle}-oracle`;
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await setSessionEnv(session);
    await new Promise(r => setTimeout(r, 300));
    await tmux.sendText(`${session}:${mainWindowName}`, buildCommandInDir(mainWindowName, repoPath));
    console.log(`\x1b[32m+\x1b[0m created session '${session}' (main: ${mainWindowName})`);

    // Auto-register agent in config.agents so federation peers can route to it (#285)
    const config = loadConfig();
    const agents = config.agents || {};
    if (!(oracle in agents)) {
      const node = config.node || "local";
      saveConfig({ agents: { ...agents, [oracle]: node } });
      console.log(`\x1b[32m+\x1b[0m registered agent '${oracle}' → '${node}' in config.agents`);
    }

    if (!opts.task && !opts.wt) {
      const allWt = await findWorktrees(parentDir, repoName);
      const usedNames = new Set<string>();
      for (const wt of allWt) {
        const taskPart = wt.name.replace(/^\d+-/, "");
        let wtWindowName = `${oracle}-${taskPart}`;
        if (usedNames.has(wtWindowName)) wtWindowName = `${oracle}-${wt.name}`;
        usedNames.add(wtWindowName);
        await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
        await new Promise(r => setTimeout(r, 300));
        await tmux.sendText(`${session}:${wtWindowName}`, buildCommandInDir(wtWindowName, wt.path));
        console.log(`\x1b[32m+\x1b[0m window: ${wtWindowName}`);
      }
    }
  } else {
    await setSessionEnv(session);
    let preExistingWindows = new Set<string>();
    try { preExistingWindows = new Set((await tmux.listWindows(session)).map(w => w.name)); } catch { /* ok */ }

    if (!opts.task && !opts.wt) {
      const allWt = await findWorktrees(parentDir, repoName);
      if (allWt.length > 0) {
        const existingWindows = [...preExistingWindows];
        const usedNames = new Set(existingWindows);
        for (const wt of allWt) {
          const taskPart = wt.name.replace(/^\d+-/, "");
          let wtWindowName = `${oracle}-${taskPart}`;
          if (usedNames.has(wtWindowName)) {
            if (existingWindows.includes(wtWindowName)) continue;
            wtWindowName = `${oracle}-${wt.name}`;
          }
          const altName = `${oracle}-${wt.name}`;
          if (existingWindows.includes(wtWindowName) || existingWindows.includes(altName)) continue;
          usedNames.add(wtWindowName);
          await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
          await new Promise(r => setTimeout(r, 300));
          await tmux.sendText(`${session}:${wtWindowName}`, buildCommandInDir(wtWindowName, wt.path));
          console.log(`\x1b[32m↻\x1b[0m respawned: ${wtWindowName}`);
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
  let windowName = `${oracle}-oracle`;

  if (opts.listWt) {
    const worktrees = await findWorktrees(parentDir, repoName);
    if (!worktrees.length) { console.log(`\x1b[90mNo worktrees for ${oracle}.\x1b[0m`); }
    else {
      console.log(`\n\x1b[36mWorktrees for ${oracle}\x1b[0m (${worktrees.length})\n`);
      for (const wt of worktrees) console.log(`  \x1b[32m●\x1b[0m ${wt.name}  \x1b[90m${wt.path}\x1b[0m`);
    }
    return `${session}:${windowName}`;
  }

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
        await tmux.sendText(`${session}:${existingWindow}`, `${buildCommandInDir(existingWindow, targetPath)} -p '${escaped}'`);
        if (opts.attach) await attachToSession(session);
        await maybeSplit(`${session}:${existingWindow}`, opts);
        return `${session}:${existingWindow}`;
      }
      console.log(`\x1b[33m⚡\x1b[0m '${existingWindow}' already running in ${session}`);
      if (opts.attach) {
        await tmux.selectWindow(`${session}:${existingWindow}`);
        await attachToSession(session);
      }
      await maybeSplit(`${session}:${existingWindow}`, opts);
      return `${session}:${existingWindow}`;
    }
  } catch { /* session might be fresh */ }

  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise(r => setTimeout(r, 300));
  const cmd = buildCommandInDir(windowName, targetPath);
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await tmux.sendText(`${session}:${windowName}`, `${cmd} -p '${escaped}'`);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }

  console.log(`\x1b[32m✅\x1b[0m woke '${windowName}' in ${session} → ${targetPath}`);
  if (opts.attach) await attachToSession(session);

  await maybeSplit(`${session}:${windowName}`, opts);

  takeSnapshot("wake").catch(() => {});
  return `${session}:${windowName}`;
}

