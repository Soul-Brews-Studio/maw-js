import { hostExec, tmux, curlFetch } from "../../sdk";
import { loadConfig, getEnvVars } from "../../config";
import { ghqFind, ghqList } from "../../core/ghq";
import { pickOracle, resolveOracle as resolveSharedOracle, type OracleRef } from "../../core/resolve";
import { resolveFleetWindowSessionTarget, resolveNumericFleetStemPrefix, resolveSessionTarget } from "../../core/matcher/resolve-target";
import { isInfrastructureChannelSessionName } from "../../core/matcher/channel-session";
import { readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { worktreeNameFromPath } from "../../core/fleet/worktree-layout";
import { scanWorktrees, type WorktreeInfo } from "../../core/fleet/worktrees-scan";
import { scanSuggestOracle } from "./wake-resolve-scan-suggest";
import { loadFleet, type FleetWindow } from "./fleet-load";
import type { Session } from "../../core/runtime/find-window";

/**
 * Worktree fallback for resolveOracle: if maw ls can see a worktree whose
 * main repo matches `${oracle}-oracle`, the main repo must be on disk even
 * if ghq doesn't know about it. Accepts injected deps for testability.
 *
 * Returns the resolved repo info, or null if no matching worktree is found
 * or the main repo path cannot be determined.
 *
 * @internal — exported for tests only (test/wake-resolve.test.ts).
 *   The production caller is `resolveOracle` in this same file. Tests use
 *   injected deps to exercise the fallback in isolation; no other module
 *   imports this symbol.
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

type LocalOracleResolution =
  | { kind: "none" }
  | { kind: "exact"; match: string }
  | { kind: "fuzzy"; match: string }
  | { kind: "ambiguous"; candidates: string[] };

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function repoNameFromPath(path: string): string {
  return path.split("/").pop() ?? "";
}

function repoSlugFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : repoNameFromPath(path);
}

function stripOracleSuffix(name: string): string {
  return name.replace(/-oracle$/i, "");
}

function stripNumericFleetPrefix(name: string): string {
  return name.replace(/^\d+-/, "");
}

function localOracleIntentNames(oracle: string): string[] {
  const raw = oracle.trim().toLowerCase();
  const withoutNumeric = stripNumericFleetPrefix(raw);
  return uniqueStrings([
    raw,
    stripOracleSuffix(raw),
    withoutNumeric,
    stripOracleSuffix(withoutNumeric),
  ].filter(Boolean));
}

/**
 * Pick a local ghq `*-oracle` repo for a user-typed oracle/session target.
 *
 * Exact intent wins before the #997 substring fuzzy fallback. This preserves
 * "maw wake v3" style fuzzy lookup while preventing a full name like
 * "mawjs-codex-oracle" (or fleet session "48-mawjs-codex") from being
 * rejected as ambiguous just because "mawjs-oracle" is also local.
 *
 * @internal exported for targeted resolver regression tests.
 */
export function resolveLocalOracleRepoName(oracle: string, repos: string[]): LocalOracleResolution {
  const oracleLower = oracle.trim().toLowerCase();
  if (!oracleLower) return { kind: "none" };

  const repoRefs = repos
    .filter(p => p.toLowerCase().endsWith("-oracle"))
    .map(p => ({ path: p, name: repoNameFromPath(p), slug: repoSlugFromPath(p) }))
    .filter(r => r.name);

  const intents = new Set(localOracleIntentNames(oracle));
  const exactRefs = repoRefs.filter(ref => {
    const lower = ref.name.toLowerCase();
    const bare = stripOracleSuffix(lower);
    return intents.has(lower) || intents.has(bare);
  });
  const exactSlugs = uniqueStrings(exactRefs.map(ref => ref.slug));

  if (exactSlugs.length === 1) return { kind: "exact", match: exactRefs[0]!.name };
  if (exactSlugs.length > 1) return { kind: "ambiguous", candidates: exactSlugs };

  const candidateRefs = repoRefs.filter(ref => {
    const bare = stripOracleSuffix(ref.name.toLowerCase());
    return bare.includes(oracleLower) || oracleLower.includes(bare);
  });
  const candidateSlugs = uniqueStrings(candidateRefs.map(ref => ref.slug));

  if (candidateSlugs.length === 1) return { kind: "fuzzy", match: candidateRefs[0]!.name };
  if (candidateSlugs.length > 1) return { kind: "ambiguous", candidates: candidateSlugs };
  return { kind: "none" };
}


function isInteractivePickerAvailable(): boolean {
  try {
    const { isatty } = require("node:tty") as typeof import("node:tty");
    return isatty(0) && isatty(1);
  } catch {
    return !!process.stdin.isTTY && !!process.stdout.isTTY;
  }
}

function oracleSlug(ref: OracleRef): string {
  return `${ref.owner}/${ref.repo}`;
}

function repoInfoFromOracleRef(ref: OracleRef): { repoPath: string; repoName: string; parentDir: string } | null {
  if (!ref.path) return null;
  return { repoPath: ref.path, repoName: ref.repo, parentDir: ref.path.replace(/\/[^/]+$/, "") };
}

async function resolveLocalOracleWithPicker(
  oracle: string,
): Promise<{ repoPath: string; repoName: string; parentDir: string; fuzzy: boolean } | null> {
  const repos = await ghqList().catch(() => [] as string[]);
  if (repos.length === 0) return null;
  let result = await resolveSharedOracle(oracle, {
    nameSpace: "oracle",
    matchPolicy: "exact",
    repos,
  });
  let fuzzy = false;

  if (result.kind === "not-found") {
    result = await resolveSharedOracle(oracle, {
      nameSpace: "oracle",
      matchPolicy: "substring",
      repos,
    });
    fuzzy = result.kind === "exact";
  }

  if (result.kind === "not-found") return null;
  if (result.kind === "exact") {
    const info = repoInfoFromOracleRef(result.oracle);
    return info ? { ...info, fuzzy } : null;
  }

  console.error(`\x1b[33m⚠\x1b[0m '${oracle}' matches ${result.candidates.length} local oracles:`);
  for (const c of result.candidates) console.error(`\x1b[90m    • ${oracleSlug(c)}\x1b[0m`);

  if (isInteractivePickerAvailable()) {
    const picked = await pickOracle(result.candidates);
    const info = picked ? repoInfoFromOracleRef(picked) : null;
    if (info) return { ...info, fuzzy: false };
    console.error(`\x1b[90m  aborted\x1b[0m`);
  } else {
    console.error(`\x1b[90m  use the full name: maw wake <org>/<repo>\x1b[0m`);
  }
  process.exit(1);
}

export async function resolveOracle(
  oracle: string,
  opts?: { allLocal?: boolean },
): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  // #997 — match against local *-oracle repos in ghq before remote lookups.
  // e.g. "v3" matches "arra-oracle-v3-oracle" so `maw wake v3` works like `maw ls -a`.
  //
  // #1635 — do this from the full ghq list before the old `ghqFind(/name)`
  // fast path. `ghqFind(/pulse-oracle)` returns the first suffix hit, which
  // silently picks one org when both `laris-co/pulse-oracle` and
  // `Soul-Brews-Studio/pulse-oracle` are local. Bare-name ambiguity must fail
  // loudly with org/repo candidates.
  const resolvedLocal = await resolveLocalOracleWithPicker(oracle);
  if (resolvedLocal) {
    if (resolvedLocal.fuzzy) console.log(`\x1b[36m→\x1b[0m fuzzy match: ${resolvedLocal.repoName}`);
    return { repoPath: resolvedLocal.repoPath, repoName: resolvedLocal.repoName, parentDir: resolvedLocal.parentDir };
  }

  // Fleet configs — oracle known in a fleet, repo may need to be cloned (#237)
  let fleetRepo: string | null = null;
  try {
    for (const config of loadFleet()) {
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
    // #906 — re-check ghq for the fleet-pinned repo BEFORE shelling out to
    // `ghq get`. The earlier `ghqFind(\`/${oracle}-oracle\`)` only matches
    // by oracle name; a fleet pin can name a repo whose slug differs from
    // `${oracle}-oracle` (e.g. `mawjs-2 → mawjs-2-oracle` clones fine, but
    // also any custom repo name). When the manual workaround in #906 ran
    // `ghq get` outside `maw`, the repo IS on disk but the first ghqFind
    // miss left us re-cloning every wake. Re-check by the fleet slug's
    // last segment so the second `maw wake` short-circuits cleanly.
    const fleetRepoStem = fleetRepo.split("/").pop()!;
    const existing = await ghqFind(`/${fleetRepoStem}`);
    if (existing) {
      return {
        repoPath: existing,
        repoName: existing.split("/").pop()!,
        parentDir: existing.replace(/\/[^/]+$/, ""),
      };
    }
    console.log(`\x1b[36m🌱\x1b[0m ${oracle} pinned in fleet → github.com/${fleetRepo} — cloning to ghq...`);
    try {
      await hostExec(`ghq get -u 'github.com/${fleetRepo}'`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\x1b[33m⚠\x1b[0m fleet-pinned ${fleetRepo} clone/update failed: ${msg.split("\n")[0]}`);
    }
    const cloned = await ghqFind(`/${fleetRepoStem}`);
    if (cloned) {
      console.log(`\x1b[32m✓\x1b[0m found at ${cloned}`);
      return { repoPath: cloned, repoName: cloned.split("/").pop()!, parentDir: cloned.replace(/\/[^/]+$/, "") };
    }
    console.error(`\x1b[31merror\x1b[0m: fleet-pinned ${fleetRepo} — clone failed and not found locally`);
    console.error(`\x1b[90m  manually: ghq get -u 'github.com/${fleetRepo}' && maw wake ${oracle}\x1b[0m`);
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

export async function findWorktrees(
  parentDir: string,
  repoName: string,
  taskSlug?: string,
  scopeStem?: string,
): Promise<{ path: string; name: string }[]> {
  const safe = (s: string) => s.replace(/'/g, "'\\''");
  const repoPath = `${parentDir}/${repoName}`;
  const outs: string[] = [];
  const legacyOut = await hostExec(`ls -d '${safe(parentDir)}'/'${safe(repoName)}'.wt-* 2>/dev/null || true`);
  outs.push(legacyOut);
  const nestedOut = await hostExec(`find '${safe(repoPath)}/agents' -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true`);
  outs.push(nestedOut);

  if (!outs.join("\n").trim() && taskSlug && scopeStem) {
    outs.push(await hostExec(
      `find '${safe(parentDir)}' -maxdepth 1 -type d -name '${safe(scopeStem)}.wt-*-${safe(taskSlug)}' 2>/dev/null || true`,
    ));
  }

  const seen = new Set<string>();
  return outs
    .join("\n")
    .split("\n")
    .filter(Boolean)
    .filter(path => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .map(path => ({ path, name: worktreeNameFromPath(path) ?? path.split("/").pop()! }));
}

export function findReusableWorktreeBySlug(
  parentDir: string,
  slug: string,
  scopeStem?: string,
  deps: { readdirSync?: typeof readdirSync; statSync?: typeof statSync } = {},
): { path: string; name: string } | null {
  const readDir = deps.readdirSync ?? readdirSync;
  const stat = deps.statSync ?? statSync;
  const suffix = `-${slug}`;
  try {
    const matches: { path: string; name: string }[] = [];
    for (const entry of readDir(parentDir)) {
      if (entry.includes(".wt-") && entry.endsWith(suffix)) {
        // #1780 — scope to the target oracle's main window stem so a reused
        // slug (e.g. "white") cannot hijack another oracle's worktree.
        if (scopeStem) {
          const stem = entry.split(".wt-")[0];
          if (stem !== scopeStem) continue;
        }
        const path = join(parentDir, entry);
        try { if (stat(path).isDirectory()) matches.push({ path, name: worktreeNameFromPath(path) ?? entry }); }
        catch { /* skip */ }
        continue;
      }

      if (scopeStem && entry === scopeStem) {
        const agentsDir = join(parentDir, entry, "agents");
        try {
          for (const wt of readDir(agentsDir)) {
            if (!wt.endsWith(suffix)) continue;
            const path = join(agentsDir, wt);
            try { if (stat(path).isDirectory()) matches.push({ path, name: wt }); }
            catch { /* skip */ }
          }
        } catch { /* no nested agents */ }
      }
    }
    matches.sort((a, b) => a.path.localeCompare(b.path));
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

export function getSessionMap(): Record<string, string> { return loadConfig().sessions; }

export function resolveFleetSession(oracle: string): string | null {
  try {
    const resolved = resolveFleetWindowSessionTarget(oracle, loadFleet());
    if (resolved.kind === "fuzzy" || resolved.kind === "exact") return resolved.match.name;
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function detectSession(oracle: string, urlRepoName?: string): Promise<string | null> {
  const sessions = await tmux.listSessions();
  const mapped = getSessionMap()[oracle];
  if (mapped && sessions.find(s => s.name === mapped)) return mapped;
  const scopedSessions = sessions.filter(s => !isInfrastructureChannelSessionName(s.name, urlRepoName ?? oracle));
  const numericSessions = scopedSessions.filter(s => /^\d+-/.test(s.name));

  // #769 — URL/slug input expresses the FULL repo intent (e.g. "m5-oracle").
  // The bare `oracle` is the stripped form ("m5"), and falling through to the
  // generic suffix match would greedily hit unrelated `*-m5` sessions
  // (`01-maw-m5`, `04-ollama-m5`). Match strictly on the full repo name; if
  // none, return null so the caller auto-creates a session named after it.
  if (urlRepoName) {
    const exact = scopedSessions.find(s => s.name === urlRepoName || s.name === oracle);
    if (exact) return exact.name;

    // #1794 family — once repo resolution has proven the target oracle
    // (e.g. `discord` → `discord-oracle`), keep session detection scoped to
    // that oracle's fleet metadata before considering generic tmux names.
    // Role-suffixed fleet sessions such as `23-discord-admin` are the
    // canonical live session for window/repo `discord-oracle`; unrelated
    // `*-discord-*` channel/helper sessions must not influence attach/wake.
    const fleetSession =
      resolveFleetSession(urlRepoName) ||
      resolveFleetSession(oracle);
    if (fleetSession && sessions.find(s => s.name === fleetSession)) return fleetSession;

    const numbered = scopedSessions.filter(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${urlRepoName}`));
    if (numbered.length === 1) return numbered[0]!.name;
    if (numbered.length > 1) {
      console.error(`\x1b[31merror\x1b[0m: '${urlRepoName}' is ambiguous — matches ${numbered.length} fleet sessions:`);
      for (const s of numbered) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
      console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
      process.exit(1);
    }
    return null;
  }

  // Fleet window metadata is authoritative for sessions whose operator role
  // suffix differs from the oracle repo/window name, e.g. discord-oracle lives
  // in 23-discord-admin. Try this before generic suffix matching so unrelated
  // aux/channel sessions like odin-discord do not steal `maw wake discord`.
  const fleetSession = resolveFleetSession(oracle);
  if (fleetSession && sessions.find(s => s.name === fleetSession)) return fleetSession;

  // Numeric-prefixed fleet sessions get first dibs — "110-yeast" beats a bare
  // "yeast" or an ephemeral "yeast-view" when the user types "yeast". If two
  // fleet sessions suffix-match, surface loudly rather than silently picking one.
  const numericOracleRepo = oracle.endsWith("-oracle")
    ? []
    : numericSessions.filter(s => s.name.endsWith(`-${oracle}-oracle`));
  if (numericOracleRepo.length === 1) return numericOracleRepo[0]!.name;
  if (numericOracleRepo.length > 1) {
    console.error(`\x1b[31merror\x1b[0m: '${oracle}' is ambiguous — matches ${numericOracleRepo.length} fleet oracle sessions:`);
    for (const s of numericOracleRepo) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
    console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
    process.exit(1);
  }

  const numeric = numericSessions.filter(s => s.name.endsWith(`-${oracle}`));
  if (numeric.length === 1) return numeric[0]!.name;
  if (numeric.length > 1) {
    console.error(`\x1b[31merror\x1b[0m: '${oracle}' is ambiguous — matches ${numeric.length} fleet sessions:`);
    for (const s of numeric) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
    console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
    process.exit(1);
  }

  // #1794 — wake may be invoked with a short fuzzy oracle token ("homeke")
  // while the live fleet session is the canonical numbered name
  // ("20-homekeeper"). `resolveSessionTarget(..., { fleetSessions: true })`
  // correctly refuses numeric prefix/middle matches so `maw a mawjs` does not
  // hijack `114-mawjs-no2` (#535), but that also means a safe prefix of the
  // canonical fleet stem misses and wake tries to create a duplicate session.
  // Accept only prefixes that continue inside the same word, not at a dash
  // boundary, and fail loudly when more than one live fleet stem matches.
  const numericPrefix = resolveNumericFleetStemPrefix(oracle, numericSessions);
  if (numericPrefix.kind === "fuzzy") return numericPrefix.match.name;
  if (numericPrefix.kind === "ambiguous") {
    console.error(`\x1b[31merror\x1b[0m: '${oracle}' is ambiguous — matches ${numericPrefix.candidates.length} fleet sessions:`);
    for (const s of numericPrefix.candidates) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
    console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
    process.exit(1);
  }

  // No fleet match — defer to the canonical resolver on non-ephemeral sessions
  // (wake shouldn't treat a *-view clone as "the oracle is running"). Exact
  // wins; ambiguous non-numeric matches surface loudly.
  const candidates = scopedSessions.filter(s => !s.name.endsWith("-view") && !s.name.startsWith("maw-pty-"));
  const r = resolveSessionTarget(oracle, candidates);
  if (r.kind === "exact" || r.kind === "fuzzy") return r.match.name;
  if (r.kind === "ambiguous") {
    console.error(`\x1b[31merror\x1b[0m: '${oracle}' is ambiguous — matches ${r.candidates.length} sessions:`);
    for (const s of r.candidates) console.error(`\x1b[90m    • ${s.name}\x1b[0m`);
    console.error(`\x1b[90m  use the full name: maw wake <exact-session>\x1b[0m`);
    process.exit(1);
  }

  return null;
}

export interface SetSessionEnvDeps {
  getEnvVars?: typeof getEnvVars;
  spawn?: typeof Bun.spawn;
  setEnvironment?: typeof tmux.setEnvironment;
}

export async function setSessionEnv(session: string, deps: SetSessionEnvDeps = {}): Promise<void> {
  const readEnvVars = deps.getEnvVars ?? getEnvVars;
  const spawn = deps.spawn ?? Bun.spawn;
  const setEnvironment = deps.setEnvironment ?? tmux.setEnvironment.bind(tmux);

  for (const [key, val] of Object.entries(readEnvVars())) {
    if (val.startsWith("pass:")) {
      const secretName = val.slice(5);
      const proc = spawn(["pass", "show", secretName], { stdout: "pipe", stderr: "pipe" });
      const [secret, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`pass show '${secretName}' failed (exit ${code})`);
      await setEnvironment(session, key, secret.trimEnd());
    } else {
      await setEnvironment(session, key, val);
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
