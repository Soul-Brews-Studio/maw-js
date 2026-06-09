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
/**
 * Result of {@link RepoDiscovery.detectFromCwd}. Both fields are optional:
 *   - `oracle` is set when the path contains a `<name>-oracle` segment.
 *   - `worktree` is set when the path is inside a worktree
 *     (nested `agents/<slug>` or legacy `.wt-<slug>`).
 * Implementations return `null` (not an empty object) when nothing matches —
 * callers use `?? {}` when they want the empty-object semantics.
 */
export interface RepoDetectResult {
  oracle?: string;
  worktree?: string;
}

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

  /**
   * Detect `{ oracle, worktree }` from a directory path. Recognizes:
   *   - nested worktree layout `…/<oracle>-oracle/agents/<worktree>`,
   *   - legacy worktree dirs `…/<oracle>-oracle.wt-<worktree>`,
   *   - a plain `<oracle>-oracle` segment anywhere up the path.
   * Returns `null` when no `-oracle` segment is present (e.g. a source-repo
   * dir like `maw-js`). Pure path-string analysis — does NOT consult the
   * backend (so it's sync and free of I/O). `cwd` defaults to `process.cwd()`.
   *
   * #2573 — consolidates the ad-hoc CWD-to-repo logic previously duplicated
   * across `bringCwdMetadata`, `deriveOracleFromCwd`, and `oracle-workon`.
   */
  detectFromCwd(cwd?: string): RepoDetectResult | null;
}
