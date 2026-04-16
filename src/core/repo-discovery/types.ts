/**
 * RepoDiscovery — adapter interface for locating repositories on disk.
 *
 * Today only `ghq` is implemented (GhqDiscovery), but this seam lets future
 * backends plug in without changing call sites: plain filesystem scan,
 * jj repos, custom manifests, etc. Selection happens in ./index via
 * `MAW_REPO_DISCOVERY` env var.
 *
 * Contract guarantees every implementation MUST honor:
 *   - Paths are normalized to forward slashes (`\\` → `/`). This matches
 *     what maw-js call sites expect — they build path patterns with `/`.
 *   - Suffix matching is **case-insensitive**. GitHub treats repo names as
 *     case-preserving but case-insensitive; ghq stores them case-preserving
 *     but users don't think in the stored case.
 *   - `findBySuffix` returns `null` (not `undefined`) on no match, so
 *     call sites can use `?? fallback` uniformly.
 *   - `list` returns `[]` (not throws) on backend failure. Callers treat
 *     "no repos found" and "ghq not installed" identically — neither
 *     should crash the CLI.
 */
export interface RepoDiscovery {
  /** Implementation identity — diagnostics/logging only, never branched on. */
  readonly name: string;

  /** All repo paths, normalized to forward slashes. Returns `[]` on backend failure. */
  list(): Promise<string[]>;

  /** Sync variant — for CLI bootstrap paths where async isn't available. */
  listSync(): string[];

  /**
   * First path ending with `suffix` (case-insensitive).
   * Returns `null` on no match. Use a leading `/` to anchor at a path
   * boundary (e.g. `/maw-ui` matches `.../org/maw-ui` but not `.../foo-maw-ui`).
   */
  findBySuffix(suffix: string): Promise<string | null>;

  /** Sync variant of findBySuffix. */
  findBySuffixSync(suffix: string): string | null;
}
