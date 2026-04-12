import { hostExec } from "../ssh";
import { tmux } from "../tmux";
import { loadConfig, getEnvVars } from "../config";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../paths";
import { curlFetch } from "../curl-fetch";

/** Fetch a GitHub issue and build a prompt for claude -p */
export async function fetchIssuePrompt(issueNum: number, repo?: string): Promise<string> {
  let repoSlug = repo;
  if (!repoSlug) {
    try {
      const remote = await hostExec("git remote get-url origin 2>/dev/null");
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (m) repoSlug = m[1];
    } catch { /* expected */ }
  }
  if (!repoSlug) throw new Error("Could not detect repo — pass --repo org/name");

  const json = await hostExec(`gh issue view ${issueNum} --repo '${repoSlug}' --json title,body,labels`);
  const issue = JSON.parse(json);
  const labels = (issue.labels || []).map((l: any) => l.name).join(", ");
  return [
    `Work on issue #${issueNum}: ${issue.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    issue.body || "(no description)",
  ].filter(Boolean).join("\n");
}

export async function resolveOracle(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string }> {
  const ghqOut = await hostExec(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`);
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
        const fullPath = await hostExec(`ghq list --full-path | grep -i '/${win.repo.replace(/^[^/]+\//, "")}$' | head -1`);
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
      const cloned = await hostExec(`ghq list --full-path | grep -i '/${slug.split("/").pop()}$' | head -1`);
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
  const patternMatch = sessions.find(s => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`))?.name
    || sessions.find(s => s.name === oracle)?.name;
  if (patternMatch) return patternMatch;
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

// --- Wake target parsing (URL / org-repo slug detection) ------------------

/** Matches "org/repo" — exactly two segments, GitHub-safe characters only */
const ORG_REPO_SLUG = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/** Matches GitHub URLs: https://github.com/org/repo[.git][/issues/N][/...] and git@ SSH form */
const GITHUB_URL = /^(?:https?:\/\/|git@)github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?(?:\/issues\/(\d+))?(?:\/.*)?$/;

function matchGitHubUrl(input: string): { org: string; repo: string; issueNum?: number } | null {
  const m = input.match(GITHUB_URL);
  if (!m) return null;
  return { org: m[1], repo: m[2], ...(m[3] ? { issueNum: parseInt(m[3]) } : {}) };
}

function isOrgRepoSlug(input: string): boolean {
  return ORG_REPO_SLUG.test(input);
}

function stripOracleSuffix(repoName: string): string {
  return repoName.replace(/-oracle$/, "");
}

export interface ParsedWakeTarget {
  /** Oracle name derived from repo (e.g. "mawjs" from "mawjs-oracle") */
  oracle: string;
  /** org/repo slug for ghq clone (e.g. "Soul-Brews-Studio/mawjs-oracle") */
  slug: string;
  /** Issue number if the URL contained /issues/N */
  issueNum?: number;
}

/**
 * Detect whether a wake target is a GitHub URL or org/repo slug.
 * Returns null if the target is a plain oracle name (existing behavior).
 */
export function parseWakeTarget(target: string): ParsedWakeTarget | null {
  const cleaned = target.trim();

  // Full GitHub URL: https://github.com/org/repo, git@github.com:org/repo.git, etc.
  const ghUrl = matchGitHubUrl(cleaned);
  if (ghUrl) {
    return {
      oracle: stripOracleSuffix(ghUrl.repo),
      slug: `${ghUrl.org}/${ghUrl.repo}`,
      ...(ghUrl.issueNum ? { issueNum: ghUrl.issueNum } : {}),
    };
  }

  // Short slug: "org/repo" (exactly one slash, no protocol prefix)
  if (isOrgRepoSlug(cleaned)) {
    const [org, rawRepo] = cleaned.split("/");
    const repo = rawRepo.replace(/\.git$/, "");
    return { oracle: stripOracleSuffix(repo), slug: `${org}/${repo}` };
  }

  // Plain oracle name — let existing resolution handle it
  return null;
}
