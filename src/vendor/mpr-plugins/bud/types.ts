/**
 * Bud plugin — shared types.
 *
 * `BudOpts` lives in impl.ts for historical reasons; new-feature types land here.
 * See docs/bud/from-repo-design.md for the `--from-repo` design.
 */

/** Options for `maw bud --from-repo <target> --stem <stem>`. Issue #588. */
export interface FromRepoOpts {
  /** The target repo. Accepts a local absolute path, `org/repo` slug, or git URL. */
  target: string;
  /** Stem of the oracle name; `-oracle` MUST NOT be included (impl.ts rejects it). */
  stem: string;
  /** Heuristic — `target` parses as a URL / slug rather than a filesystem path. */
  isUrl: boolean;
  /** Open a PR on the target instead of committing to the default branch. */
  pr: boolean;
  /** Print the injection plan and exit without writing. */
  dryRun: boolean;
  /** Suppress the ψ/-collision blocker. Never destructive — mkdir is idempotent. */
  force?: boolean;
  /** Parent oracle stem — embedded as lineage in CLAUDE.md (and fleet entry). */
  from?: string;
  /** Keep ψ/ tracked in git. Default: append `ψ/` to target .gitignore. */
  trackVault?: boolean;
  /** Pre-load parent's ψ/memory/ into target at bud time. Requires `from`. */
  seed?: boolean;
  /** Snapshot host peers.json into target's ψ/peers.json as a portable seed. */
  syncPeers?: boolean;
}

/** One file in the injection plan — what would be added or appended. */
export interface InjectionAction {
  kind: "mkdir" | "write" | "append" | "skip";
  path: string;
  reason?: string;
}

/** Result of `planFromRepoInjection` — a read-only preview. */
export interface InjectionPlan {
  target: string;
  stem: string;
  actions: InjectionAction[];
  /** If non-empty, the plan cannot proceed — `cmdBudFromRepo` must refuse. */
  blockers: string[];
}
