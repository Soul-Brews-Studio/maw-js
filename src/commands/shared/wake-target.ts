/**
 * Wake target parsing — detect GitHub URLs and org/repo slugs.
 *
 * Extracted from wake-resolve.ts to avoid pulling in the config.ts
 * import chain during tests (bun CI has a module resolution issue
 * with re-exported getEnvVars from config.ts).
 */

import { hostExec } from "../../sdk";
import { ghqFind } from "../../core/ghq";

// --- URL/slug detection ---------------------------------------------------

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

interface ParsedWakeTarget {
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

/**
 * Ensure a repo is cloned via ghq. Checks locally first (fast),
 * clones from GitHub only if not found. Silent on failure — lets
 * resolveOracle handle the error downstream.
 */
export async function ensureCloned(slug: string): Promise<void> {
  const ghqHit = await ghqFind(`/${slug}`);
  if (ghqHit) return;
  console.log(`\x1b[36m⚡\x1b[0m cloning ${slug}...`);
  try {
    await hostExec(`ghq get github.com/${slug}`);
  } catch (e: any) {
    console.log(`\x1b[33m⚠\x1b[0m clone failed: ${e.message || e}\n  falling back to normal resolution`);
  }
}
