/**
 * gh-user-orgs.ts — shared helper for resolving the orgs the current `gh`
 * authenticated user can host repos in.
 *
 * Two callers today:
 *   - `wake-resolve-scan-suggest.ts` (#770) — filter the ghq org list to
 *     orgs the user actually owns/is a member of, before suggesting which
 *     repo to clone for an unknown oracle.
 *   - bud plugin (Phase 2) — cold-start fallback for `smartDefaultOrg`
 *     when the local fleet is empty (first oracle on a fresh machine).
 *
 * Process-lifetime cache: a single `gh api user/orgs` per maw invocation.
 * Test isolation via `_resetAllowedOrgsCache`.
 *
 * Failure mode: any `gh` failure (no auth, offline, gh missing, scope
 * mismatch) returns `ok: false` so callers can fall back gracefully —
 * never silently empty out.
 *
 * Multi-host (`github.com` + GHE) is a known unsolved limitation; the
 * function defaults to whichever `gh` host is active. Tracked as a
 * pre-existing maw-js issue, not introduced by this extraction.
 */

/**
 * Result of probing GitHub for the orgs the authenticated user can
 * actually own a repo in. `ok: false` triggers a graceful fallback to
 * the unfiltered scan with a warning.
 */
export type AllowedOrgs =
  | { ok: true; user: string; orgs: Set<string> }
  | { ok: false; reason: string };

let _allowedOrgsCache: AllowedOrgs | null = null;

/** @internal — exported only so tests can isolate cases. */
export function _resetAllowedOrgsCache(): void {
  _allowedOrgsCache = null;
}

/**
 * Probe `gh api user` and `gh api user/orgs` to derive the orgs the user
 * can actually host a repo in. Cached on first call. On any failure
 * returns `ok: false` so the caller can fall back.
 *
 * Caller injects `execFn` (synchronous shell exec) so tests can mock
 * the gh boundary without touching the real network.
 */
export function fetchAllowedOrgs(execFn: (cmd: string) => string): AllowedOrgs {
  if (_allowedOrgsCache) return _allowedOrgsCache;

  let user: string;
  try {
    user = execFn("gh api user --jq .login 2>/dev/null").trim();
    if (!user) throw new Error("empty login");
  } catch (e: any) {
    const reason = `gh api user failed: ${String(e?.message || e).split("\n")[0]}`;
    return (_allowedOrgsCache = { ok: false, reason });
  }

  const orgs = new Set<string>([user]);
  try {
    const raw = execFn("gh api user/orgs --jq '.[].login' 2>/dev/null");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t) orgs.add(t);
    }
  } catch {
    // user lookup worked but org listing failed (e.g. token without `read:org`).
    // Falling through with just the user is still better than scanning all-local.
  }

  return (_allowedOrgsCache = { ok: true, user, orgs });
}
