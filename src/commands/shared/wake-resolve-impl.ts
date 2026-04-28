import { hostExec, tmux, FLEET_DIR, curlFetch } from "../../sdk";
import { loadConfig, getEnvVars } from "../../config";
import { ghqFind } from "../../core/ghq";
import { resolveSessionTarget } from "../../core/matcher/resolve-target";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { scanWorktrees, type WorktreeInfo } from "../../core/fleet/worktrees-scan";
import { scanSuggestOracle } from "./wake-resolve-scan-suggest";
import type { FleetSession, FleetWindow } from "./fleet-load";
import type { Session } from "../../core/runtime/find-window";

/**
 * Worktree fallback for resolveOracle: if maw ls can see a worktree whose
 * main repo matches `${oracle}-oracle`, the main repo must be on disk even
 * if ghq doesn't know about it. Accepts injected deps for testability.
 *
 * Returns the resolved repo info, or null if no matching worktree is found
 * or the main repo path cannot be determined.
 */
export async function resolveFromWorktrees(
  oracle: string,
  scanFn: () => Promise<WorktreeInfo[]>,
  execFn: (cmd: string) => Promise<string>,
  existsFn: (path: string) => boolean,
): Promise<{ repoPath: string; repoName: string; parentDir: string } | null> {
  const worktrees = await scanFn();
  // Match by main repo name: "github.com/Org/wireboy-oracle" → last segment is "wireboy-oracle"
  const match = worktrees.find(wt => {
    const mainName = wt.mainRepo.split("/").pop() ?? "";
    return mainName === `${oracle}-oracle`;
  });
  if (!match) return null;

  // git rev-parse --git-common-dir from a linked worktree returns the main repo's .git path
  // e.g. /home/user/ghq/github.com/Soul-Brews-Studio/wireboy-oracle/.git
  const gitCommonDir = (await execFn(`git -C '${match.path}' rev-parse --git-common-dir 2>/dev/null`)).trim();
  if (!gitCommonDir) return null;

  const mainRepoPath = gitCommonDir.endsWith("/.git")
    ? gitCommonDir.slice(0, -5)
    : gitCommonDir;

  if (!existsFn(mainRepoPath)) return null;

  return {
    repoPath: mainRepoPath,
    repoName: mainRepoPath.split("/").pop()!,
    parentDir: mainRepoPath.replace(/\/[^/]+$/, ""),
  };
}

export async function resolveOracle(
  oracle: string,
  opts?: { allLocal?: boolean },
): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  const ghqHit = await ghqFind(`/${oracle}-oracle`);
  if (ghqHit) {
    const repoPath = ghqHit;
    return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
  }

  // Fleet configs — oracle known in a fleet, repo may need to be cloned (#237)
  let fleetRepo: string | null = null;
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8")) as FleetSession;
      const win = (config.windows || []).find((w: FleetWindow) => w.name === `${oracle}-oracle` || w.name === oracle);
      if (win?.repo) {
        const fullPath = await ghqFind(`/${win.repo.replace(/^[^/]+\//, "")}`);
        if (fullPath) {
          const repoPath = fullPath;
          return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
        }
        // Fleet knows the slug but it's not cloned yet — remember for step 3
        fleetRepo = win.repo;
      }
    }
  } catch { /* fleet dir may not exist */ }

  // Worktree fallback: if `maw ls` shows this oracle as a worktree, the main repo
  // exists on disk even if ghq doesn't know about it (e.g. after moving ghq roots
  // or on a machine where ghq was never configured). Nat's insight: having a
  // worktree guarantees a git repo.
  try {
    const worktreeResult = await resolveFromWorktrees(oracle, scanWorktrees, hostExec, existsSync);
    if (worktreeResult) return worktreeResult;
  } catch { /* scanWorktrees failed — fall through to clone */ }

  // Fleet pin is authoritative — #686. When fleet says windows[].repo, clone
  // that exact slug loudly. Do NOT fall through to scan-suggest (which would
  // re-ask for a 24-org scan we already know the answer to).
  if (fleetRepo) {
    console.log(`\x1b[36m🌱\x1b[0m ${oracle} pinned in fleet → github.com/${fleetRepo} — cloning to ghq...`);
    try {
      await hostExec(`ghq get -u 'github.com/${fleetRepo}'`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[31merror\x1b[0m: fleet-pinned ${fleetRepo} but clone failed: ${msg.split("\n")[0]}`);
      console.error(`\x1b[90m  manually: ghq get -u 'github.com/${fleetRepo}' && maw wake ${oracle}\x1b[0m`);
      process.exit(1);
    }
    const cloned = await ghqFind(`/${fleetRepo.split("/").pop()}`);
    if (cloned) {
      console.log(`\x1b[32m✓\x1b[0m cloned to ${cloned}`);
      return { repoPath: cloned, repoName: cloned.split("/").pop()!, parentDir: cloned.replace(/\/[^/]+$/, "") };
    }
    console.error(`\x1b[31merror\x1b[0m: clone of ${fleetRepo} reported success but path not found in ghq list`);
    process.exit(1);
  }

  // No fleet pin — probe configured orgs for `<oracle>-oracle`
  try {
    const cfg = loadConfig();
    const orgs: string[] = cfg.githubOrgs || (cfg.githubOrg ? [cfg.githubOrg] : ["Soul-Brews-Studio"]);
    for (const org of orgs) {
      const slug = `${org}/${oracle}-oracle`;
      // Probe — skip missing repos silently so we can fall through to federation
      try { await hostExec(`gh repo view '${slug}' --json name 2>/dev/null`); }
      catch { continue; }
      console.log(`\x1b[36m🌱\x1b[0m ${oracle} not found locally — cloning github.com/${slug} into ghq...`);
      try { await hostExec(`ghq get -u 'github.com/${slug}'`); }
      catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`\x1b[33m⚠\x1b[0m  clone failed for ${slug}: ${msg.split("\n")[0]}`);
        continue;
      }
      const cloned = await ghqFind(`/${slug.split("/").pop()}`);
      if (cloned) {
        const repoPath = cloned;
        console.log(`\x1b[32m✓\x1b[0m cloned to ${repoPath}`);
        return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
      }
    }
  } catch { /* probe/clone best-effort — fall through to federation */ }

  // Federation fallback: check peers
  try {
    const config = loadConfig();
    const peers = config.peers || [];
    for (const peer of peers) {
      try {
        const res = await curlFetch(`${peer}/api/sessions`, { timeout: 10000 });
        if (!res.ok) continue;
        const data = res.data;
        const list: Session[] = Array.isArray(data) ? data : (data?.sessions || []);
        for (const s of list) {
          const oracleLower = oracle.toLowerCase();
          const sessionMatch = s.name.toLowerCase().includes(oracleLower);
          const found = (s.windows || []).find(w =>
            w.name === `${oracle}-oracle` || w.name === oracle || w.name.toLowerCase().startsWith(oracleLower)
          ) || (sessionMatch ? (s.windows || [])[0] : null);
          if (found) {
            console.log(`\x1b[36m⚡\x1b[0m ${oracle} found on peer ${peer} — waking remotely`);
            await curlFetch(`${peer}/api/send`, { method: "POST", body: JSON.stringify({ target: `${s.name}:${found.index}`, text: "" }), from: "auto" /* #804 Step 4 SIGN — sign cross-node remote-wake /api/send */ });
            console.log(`\x1b[32m✓\x1b[0m ${oracle} is running on ${peer} (session ${s.name}:${found.name})`);
            process.exit(0);
          }
        }
      } catch { /* peer unreachable */ }
    }
  } catch { /* no peers */ }

  // Scan suggest: offer interactive org scan when all silent resolution paths fail
  try {
    const scanned = await scanSuggestOracle(oracle, { allLocal: opts?.allLocal });
    if (scanned) return scanned;
  } catch { /* scan suggest failed — fall through to original error */ }

  console.error(`oracle repo not found: ${oracle} (tried ghq, fleet configs, worktree scan, GitHub clone, and ${(loadConfig().peers || []).length} peers — try: maw bud ${oracle}  OR  ghq get <url>)`);
  process.exit(1);
}

export async function findWorktrees(parentDir: string, repoName: string): Promise<{ path: string; name: string }[]> {
  const lsOut = await hostExec(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
  return lsOut.split("\n").filter(Boolean).map(p => ({
    path: p, name: p.split("/").pop()!.replace(`${repoName}.wt-`, ""),
  }));
}

export function getSessionMap(): Record<string, string> { return loadConfig().sessions; }

export function resolveFleetSession(oracle: string): string | null {
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8")) as FleetSession;
      if ((config.windows || []).some((w: FleetWindow) => w.name === `${oracle}-oracle` || w.name === oracle)) return config.name;
    }
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function detectSession(oracle: string, urlRepoName?: string): Promise<string | null> {
  const sessions = await tmux.listSessions();
  const mapped = getSessionMap()[oracle];
  if (mapped && sessions.find(s => s.name === mapped)) return mapped;

  // #769 — URL/slug input expresses the FULL repo intent (e.g. "m5-oracle").
  // The bare `oracle` is the stripped form ("m5"), and falling through to the
  // generic suffix match would greedily hit unrelated `*-m5` sessions
  // (`01-maw-m5`, `04-ollama-m5`). Match strictly on the full repo name; if
  // none, return null so the caller auto-creates a session named after it.
  if (urlRepoName) {
    const exact = sessions.find(s => s.name === urlRepoName || s.name === oracle);
    if (exact) return exact.name;
    const numbered = sessions.filter(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${urlRepoName}`));
    if (numbered.length === 1) return numbered[0]!.name;
    if (numbered.length > 1) {
      console.error(`\x1b[31merror\x1b[0m: '${urlRepoName}' is ambiguous — matches ${numbered.length} fleet sessions:`);
      for (const s of numbered) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
      console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
      process.exit(1);
    }
    return null;
  }

  // Numeric-prefixed fleet sessions get first dibs — "110-yeast" beats a bare
  // "yeast" or an ephemeral "yeast-view" when the user types "yeast". If two
  // fleet sessions suffix-match, surface loudly rather than silently picking one.
  const numeric = sessions.filter(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`));
  if (numeric.length === 1) return numeric[0]!.name;
  if (numeric.length > 1) {
    console.error(`\x1b[31merror\x1b[0m: '${oracle}' is ambiguous — matches ${numeric.length} fleet sessions:`);
    for (const s of numeric) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
    console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
    process.exit(1);
  }

  // No fleet match — defer to the canonical resolver on non-ephemeral sessions
  // (wake shouldn't treat a *-view clone as "the oracle is running"). Exact
  // wins; ambiguous non-numeric matches surface loudly.
  const candidates = sessions.filter(s => !s.name.endsWith("-view") && !s.name.startsWith("maw-pty-"));
  const r = resolveSessionTarget(oracle, candidates);
  if (r.kind === "exact" || r.kind === "fuzzy") return r.match.name;
  if (r.kind === "ambiguous") {
    console.error(`\x1b[31merror\x1b[0m: '${oracle}' is ambiguous — matches ${r.candidates.length} sessions:`);
    for (const s of r.candidates) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
    console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
    process.exit(1);
  }

  const fleetSession = resolveFleetSession(oracle);
  if (fleetSession && sessions.find(s => s.name === fleetSession)) return fleetSession;
  return null;
}

export async function setSessionEnv(session: string): Promise<void> {
  for (const [key, val] of Object.entries(getEnvVars())) {
    if (val.startsWith("pass:")) {
      const secretName = val.slice(5);
      const proc = Bun.spawn(["pass", "show", secretName], { stdout: "pipe", stderr: "pipe" });
      const [secret, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`pass show '${secretName}' failed (exit ${code})`);
      await tmux.setEnvironment(session, key, secret.trimEnd());
    } else {
      await tmux.setEnvironment(session, key, val);
    }
  }
}

export function sanitizeBranchName(name: string): string {
  // #823 Bug A — greedy strip of leading/trailing dashes/dots so unknown CLI
  // flags that leak into the positional slot (e.g. "--no-attach") sanitize to
  // "no-attach" rather than the half-stripped "-no-attach", which then
  // becomes a corrupted worktree name "1--no-attach" downstream.
  //
  // Strip pattern split into two anchored passes:
  //   - `^[-.]+`        — `^` anchor pins the start, no backtracking possible.
  //   - `(?<![-.])[-.]+$` — negative look-behind pins the trailing run to its
  //     leftmost start, preventing the n² backtrack CodeQL's js/polynomial-redos
  //     flags on the bare `[-.]+$` form (it can begin matching anywhere within
  //     the run, then backtrack on long all-dash input).
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._\-]/g, "")
    .replace(/\.{2,}/g, ".").replace(/^[-.]+/, "").replace(/(?<![-.])[-.]+$/, "").slice(0, 50);
}

// Wake target parsing (parseWakeTarget, ensureCloned) is in wake-target.ts
// — extracted to avoid pulling config.ts import chain into tests (CI #270).
