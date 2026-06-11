/**
 * Shared normalization for ghq repo paths.
 *
 * The same path-preference rules are used by #2691 (oracle about) and now wake:
 * - Normalize Windows-style separators.
 * - Drop archived ghosts (`_archive`, `.archive`, `archive`, ...).
 * - Deduplicate by canonical `github.com/<org>/<repo>` suffix so duplicate
 *   local entries (canonical vs `github.com/github.com/...`) collapse to one.
 * - Prefer canonical (non-archived) locations when duplicates exist.
 */

const ARCHIVE_SEGMENTS = new Set<string>([
  "_archive",
  ".archive",
  "archive",
  "archives",
  "backup",
  "backups",
  "snapshot",
  "snapshots",
]);

const GITHUB_HOST_SEGMENT = "github.com";

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathSegments(path: string): string[] {
  return normalizeRepoPath(path).split("/").filter(Boolean);
}

function isDoubledGithubPath(path: string): boolean {
  const segments = pathSegments(path).map((segment) => segment.toLowerCase());
  return segments.some((segment, index) => (
    segment === GITHUB_HOST_SEGMENT && segments[index + 1] === GITHUB_HOST_SEGMENT
  ));
}

export function isArchiveLikePath(repoPath: string): boolean {
  return pathSegments(repoPath).some((segment) => ARCHIVE_SEGMENTS.has(segment.toLowerCase()));
}

export function canonicalRepoKey(repoPath: string): string {
  const normalized = normalizeRepoPath(repoPath).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const hostIndex = segments.lastIndexOf(GITHUB_HOST_SEGMENT);
  if (hostIndex >= 0 && hostIndex < segments.length - 1) {
    return segments.slice(hostIndex + 1).join("/");
  }
  return normalized;
}

function isPreferredRepoPath(candidate: string, current: string): boolean {
  // Prefer non-archived and non-doubled forms.
  const candidateArchive = isArchiveLikePath(candidate);
  const currentArchive = isArchiveLikePath(current);
  if (candidateArchive !== currentArchive) return !candidateArchive;

  const candidateDoubled = isDoubledGithubPath(candidate);
  const currentDoubled = isDoubledGithubPath(current);
  if (candidateDoubled !== currentDoubled) return !candidateDoubled;

  return false;
}

/**
 * Filter archived/duplicate ghq entries.
 * Duplicate keys keep the preferred non-archive canonical candidate.
 */
export function normalizeGhqRepos(rawRepos: readonly string[]): string[] {
  const deduped = new Map<string, string>();
  for (const raw of rawRepos) {
    const path = normalizeRepoPath(raw);
    if (!path) continue;
    if (isArchiveLikePath(path)) continue;

    const key = canonicalRepoKey(path);
    const existing = deduped.get(key);
    if (!existing || isPreferredRepoPath(path, existing)) {
      deduped.set(key, path);
    }
  }
  return [...deduped.values()];
}
