import { hostExec, tmux, FLEET_DIR, curlFetch } from "../../sdk";
import { loadConfig, getEnvVars } from "../../config";
import { resolveSessionTarget } from "../../core/matcher/resolve-target";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Resolve repo slug from git remote or --repo flag */
async function resolveRepo(repo?: string): Promise<string> {
  if (repo) return repo;
  try {
    const remote = await hostExec("git remote get-url origin 2>/dev/null");
    const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch { /* expected */ }
  throw new Error("Could not detect repo — pass --repo org/name");
}

/**
 * Fetch a GitHub issue or PR and build a prompt for claude -p.
 * One function, two modes: --issue and --pr both call this.
 */
export async function fetchGitHubPrompt(type: "issue" | "pr", num: number, repo?: string): Promise<string> {
  const repoSlug = await resolveRepo(repo);
  const cmd = type === "pr" ? "pr" : "issue";

  const json = await hostExec(
    `gh ${cmd} view ${num} --repo '${repoSlug}' --json title,body,labels` +
    (type === "pr" ? ",state,headRefName,files" : "")
  );
  const item = JSON.parse(json);
  const labels = (item.labels || []).map((l: { name: string }) => l.name).join(", ");

  if (type === "pr") {
    return [
      `Review PR #${num}: ${item.title}`,
      `Branch: ${item.headRefName} | State: ${item.state}`,
      labels ? `Labels: ${labels}` : "",
      item.files?.length ? `Files changed: ${item.files.length}` : "",
      "",
      item.body || "(no description)",
    ].filter(Boolean).join("\n");
  }

  return [
    `Work on issue #${num}: ${item.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    item.body || "(no description)",
  ].filter(Boolean).join("\n");
}

/** @deprecated Use fetchGitHubPrompt("issue", ...) */
export const fetchIssuePrompt = (num: number, repo?: string) => fetchGitHubPrompt("issue", num, repo);

export async function resolveOracle(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  const ghqOut = await hostExec(`ghq list --full-path | tr '\\\\' '/' | grep -i '/${oracle}-oracle$' | head -1`);
  if (ghqOut?.trim()) {
    const repoPath = ghqOut.trim();
    return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
  }

  // Fleet configs — oracle known in a fleet, repo may need to be cloned (#237)
  let fleetRepo: string | null = null;
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      const win = (config.windows || []).find((w: any) => w.name === `${oracle}-oracle`);
      if (win?.repo) {
        const fullPath = await hostExec(`ghq list --full-path | tr '\\\\' '/' | grep -i '/${win.repo.replace(/^[^/]+\//, "")}$' | head -1`);
        if (fullPath?.trim()) {
          const repoPath = fullPath.trim();
          return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
        }
        // Fleet knows the slug but it's not cloned yet — remember for step 3
        fleetRepo = win.repo;
      }
    }
  } catch { /* fleet dir may not exist */ }

  // Clone from GitHub — wake should prefer local-first (#237)
  // If fleet told us the exact org/slug, use that. Otherwise, probe configured orgs for `<oracle>-oracle`.
  try {
    const cfg = loadConfig() as any;
    const candidates: string[] = [];
    if (fleetRepo) candidates.push(fleetRepo);
    const orgs: string[] = cfg.githubOrgs || (cfg.githubOrg ? [cfg.githubOrg] : ["Soul-Brews-Studio"]);
    for (const org of orgs) candidates.push(`${org}/${oracle}-oracle`);

    for (const slug of candidates) {
      // Probe — skip missing repos silently so we can fall through to federation
      try { await hostExec(`gh repo view '${slug}' --json name 2>/dev/null`); }
      catch { continue; }
      console.log(`\x1b[36m🌱\x1b[0m ${oracle} not found locally — cloning github.com/${slug} into ghq...`);
      try { await hostExec(`ghq get -u 'github.com/${slug}'`); }
      catch (e: any) {
        console.error(`\x1b[33m⚠\x1b[0m  clone failed for ${slug}: ${String(e?.message || e).split("\n")[0]}`);
        continue;
      }
      const cloned = await hostExec(`ghq list --full-path | tr '\\\\' '/' | grep -i '/${slug.split("/").pop()}$' | head -1`);
      if (cloned?.trim()) {
        const repoPath = cloned.trim();
        console.log(`\x1b[32m✓\x1b[0m cloned to ${repoPath}`);
        return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
      }
    }
  } catch { /* probe/clone best-effort — fall through to federation */ }

  // Federation fallback: check peers
  try {
    const config = loadConfig();
    const peers = (config as any).peers || [];
    for (const peer of peers) {
      try {
        const res = await curlFetch(`${peer}/api/sessions`, { timeout: 10000 });
        if (!res.ok) continue;
        const sessions = res.data || [];
        const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];
        for (const s of list) {
          const oracleLower = oracle.toLowerCase();
          const sessionMatch = s.name.toLowerCase().includes(oracleLower);
          const found = (s.windows || []).find((w: any) =>
            w.name === `${oracle}-oracle` || w.name === oracle || w.name.toLowerCase().startsWith(oracleLower)
          ) || (sessionMatch ? (s.windows || [])[0] : null);
          if (found) {
            console.log(`\x1b[36m⚡\x1b[0m ${oracle} found on peer ${peer} — waking remotely`);
            await curlFetch(`${peer}/api/send`, { method: "POST", body: JSON.stringify({ target: `${s.name}:${found.index}`, text: "" }) });
            console.log(`\x1b[32m✓\x1b[0m ${oracle} is running on ${peer} (session ${s.name}:${found.name})`);
            process.exit(0);
          }
        }
      } catch { /* peer unreachable */ }
    }
  } catch { /* no peers */ }

  console.error(`oracle repo not found: ${oracle} (tried local ghq, fleet configs, GitHub clone, and ${((loadConfig() as any).peers || []).length} peers)`);
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
      const config = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      if ((config.windows || []).some((w: any) => w.name === `${oracle}-oracle` || w.name === oracle)) return config.name;
    }
  } catch { /* fleet dir may not exist */ }
  return null;
}

export async function detectSession(oracle: string): Promise<string | null> {
  const sessions = await tmux.listSessions();
  const mapped = getSessionMap()[oracle];
  if (mapped && sessions.find(s => s.name === mapped)) return mapped;

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
      await hostExec(`tmux set-environment -t '${session}' ${key} "$(pass show '${val.slice(5)}')"`)
    } else {
      await tmux.setEnvironment(session, key, val);
    }
  }
}

export function sanitizeBranchName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._\-]/g, "")
    .replace(/\.{2,}/g, ".").replace(/^[-.]|[-.]$/g, "").slice(0, 50);
}

// Wake target parsing (parseWakeTarget, ensureCloned) is in wake-target.ts
// — extracted to avoid pulling config.ts import chain into tests (CI #270).
