/**
 * Fleet-as-truth smart-default org resolution for `maw bud`.
 *
 * Architectural framing (FTS+vector retrieval pattern, mirrored from
 * arra-oracle-v3):
 *
 *   FTS-tier (fast, structural, always fresh) — local fleet entries at
 *     `~/.config/maw/fleet/*.json`. Each entry's `windows[0].repo` field
 *     is `<org>/<oracle-name>`; `budded_at` records creation time.
 *     Reading the fleet is a sub-millisecond local FS scan, hardened by
 *     the #1133 defensive filter, and "always fresh" by construction
 *     (written-on-write by maw itself).
 *
 *   Vector-tier (slow, authoritative, occasionally stale) — `gh api user`
 *     network call. Returns the user's GitHub login regardless of fleet
 *     state. Used only as cold-start fallback when fleet is empty (truly
 *     fresh machine, no oracles yet).
 *
 * The combination rule today is FALLBACK (FTS-first, vector-on-empty),
 * not parallel-merge. Future Phase 3 (when usage triggers warrant)
 * upgrades to arra-oracle-v3's parallel + selective-merge with hybrid
 * confidence bonus — see follow-up issue.
 *
 * Known limitation (sticky-default trap): recency-only ranking can keep
 * suggesting the org of a recent side-quest oracle until the user buds
 * back into their primary org. `--org <name>` is the escape hatch and
 * the echo line surfaces the source so the user can catch wrong defaults
 * before `gh repo create` fires.
 */

import { hostExec } from "maw-js/sdk";
import { loadFleet } from "maw-js/commands/shared/fleet-load";

export type OrgSource = "flag" | "env" | "config" | "fleet" | "gh" | "default";

export interface OrgResolution {
  /** The resolved GitHub org name (will be the namespace for the new repo). */
  org: string;
  /** Where the value came from — surfaced in the echo line for cross-check. */
  source: OrgSource;
  /** Optional human-readable detail (e.g., "most recent: discord-oracle, 2026-05-03"). */
  detail?: string;
}

/**
 * Walk the local fleet and return the org from the most recently budded
 * oracle. Returns null if no fleet entry has a parseable `windows[0].repo`.
 *
 * Tiebreaker: when `budded_at` is missing or equal, the numeric prefix
 * on the fleet filename (e.g., `26-sbs.json`) breaks ties — higher prefix
 * = later creation.
 *
 * Tests inject their own `loadFleetFn` to avoid touching the real
 * `~/.config/maw/fleet/` and to sidestep Bun's process-global mock.module
 * cache pollution (see smart-default-org.test.ts header).
 */
export function smartDefaultOrgFromFleet(
  loadFleetFn: typeof loadFleet = loadFleet,
): { org: string; oracle: string; date: string } | null {
  const fleet = loadFleetFn();
  const candidates = fleet
    .map(s => {
      const repo = s.windows?.[0]?.repo;
      if (!repo || typeof repo !== "string" || !repo.includes("/")) return null;
      const org = repo.split("/")[0];
      if (!org) return null;
      const oracle = s.windows?.[0]?.name || s.name;
      const ts = s.budded_at ? new Date(s.budded_at).getTime() : 0;
      const numPrefix = (() => {
        const m = /^(\d+)-/.exec(s.name || "");
        return m ? parseInt(m[1] ?? "0", 10) : 0;
      })();
      return { org, oracle, ts, numPrefix, date: s.budded_at?.slice(0, 10) ?? "" };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.ts - a.ts) || (b.numPrefix - a.numPrefix));
  const winner = candidates[0]!;
  return { org: winner.org, oracle: winner.oracle, date: winner.date };
}

/**
 * Cold-start fallback — ask `gh` who the user is. Used only when fleet
 * is empty (no oracles ever). One `gh api user` call, ~100-300ms once
 * per fresh machine. Returns null on any failure (gh missing, unauthed,
 * offline) so the caller can fall through to the hardcoded default.
 *
 * `execFn` is injectable for tests; defaults to the real `hostExec`.
 */
export async function fetchGhDefaultLogin(
  execFn: typeof hostExec = hostExec,
): Promise<string | null> {
  try {
    const out = await execFn("gh api user --jq .login 2>/dev/null");
    const login = out.trim();
    return login || null;
  } catch {
    return null;
  }
}

export interface ResolveOrgOpts {
  /** Explicit `--org <name>` flag value (highest priority). */
  flag?: string;
  /** `MAW_BUD_OWNER` env var snapshot — caller passes process.env.MAW_BUD_OWNER. */
  env?: string;
  /** `config.githubOrg` from maw config. */
  config?: string;
}

export interface ResolveOrgDeps {
  /** Override the fleet loader (tests). Defaults to real `loadFleet`. */
  loadFleetFn?: typeof loadFleet;
  /** Override the gh exec (tests). Defaults to real `hostExec`. */
  execFn?: typeof hostExec;
}

/**
 * Full precedence chain for bud's org resolution:
 *
 *   1. --org <name>                     (explicit flag wins)
 *   2. MAW_BUD_OWNER env                (per-shell override)
 *   3. config.githubOrg                 (per-machine config)
 *   4. fleet most-recent (FTS)          (smart default — NEW)
 *   5. gh api user (vector cold-start)  (NEW — fires once per fresh machine)
 *   6. "Soul-Brews-Studio"              (ultimate fallback)
 */
export async function resolveOrg(
  opts: ResolveOrgOpts,
  deps: ResolveOrgDeps = {},
): Promise<OrgResolution> {
  if (opts.flag) return { org: opts.flag, source: "flag" };
  if (opts.env) return { org: opts.env, source: "env" };
  if (opts.config) return { org: opts.config, source: "config" };

  const fleetPick = smartDefaultOrgFromFleet(deps.loadFleetFn);
  if (fleetPick) {
    const detail = fleetPick.date
      ? `most recent: ${fleetPick.oracle}, ${fleetPick.date}`
      : `most recent: ${fleetPick.oracle}`;
    return { org: fleetPick.org, source: "fleet", detail };
  }

  const ghLogin = await fetchGhDefaultLogin(deps.execFn);
  if (ghLogin) {
    return { org: ghLogin, source: "gh", detail: "cold start — no fleet entries" };
  }

  return { org: "Soul-Brews-Studio", source: "default" };
}

/** Format the source for the user-facing echo line. */
export function formatOrgSource(res: OrgResolution): string {
  const tail = res.detail ? ` (${res.detail})` : "";
  switch (res.source) {
    case "flag":    return "--org flag";
    case "env":     return "MAW_BUD_OWNER env";
    case "config":  return "config.githubOrg";
    case "fleet":   return `fleet${tail}`;
    case "gh":      return `gh user${tail}`;
    case "default": return "hardcoded default (Soul-Brews-Studio)";
  }
}
