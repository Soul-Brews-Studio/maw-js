import { isInfrastructureChannelSessionName } from "../../../core/matcher/channel-session";
import { resolveFleetWindowSessionTarget } from "../../../core/matcher/resolve-target";

/**
 * Resolve a `maw attach <target>` invocation into a tiered match.
 *
 * Phase 1 — Smart Local (#25):
 *   Tier 1 — running:  tmux session matches (incl. slot prefix / stem suffix)
 *                      → attach immediately, no prompt
 *   Tier 2 — sleeping: fleet entry matches but no live tmux session
 *                      → prompt to wake, then attach
 *   null               → nothing matched: caller emits "available oracles" hint
 *
 * Tier 3 (cross-node federation attach) lived here briefly (#1236). It was
 * pulled back out — the built-in stays local-only. Cross-node attach is now
 * the job of the `attach-ssh` plugin (registry). Operators who want it
 * install that plugin explicitly. See:
 *   ψ/memory/traces/2026-05-13/1124_maw-a-original.md
 *
 * Deps are injected for testability — same shape as the sleep resolver.
 */

export interface SessionLike {
  name: string;
  windows: Array<{ name: string }>;
}

export interface FleetLike {
  name: string;
  windows: Array<{ name: string }>;
}

export interface ResolveDeps {
  listSessions: () => Promise<SessionLike[]>;
  loadFleet: () => FleetLike[];
}

export type ResolveResult =
  | {
      tier: 1;
      sessionName: string;
      windowName?: string;
      ambiguousCandidates?: string[];
    }
  | { tier: 2; fleetName: string; ambiguousCandidates?: string[] }
  | null;

const stripDash = (s: string) => s.replace(/-+$/, "");

function normalizeAttachQuery(target: string): string {
  const trimmed = target.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return trimmed;
  const left = trimmed.slice(0, colon);
  const right = trimmed.slice(colon + 1);
  // Node-qualified targets such as `m5:mawjs` should resolve the oracle part
  // locally. Numeric window/pane suffixes (`neo:0`, `neo:1.2`) are tmux
  // syntax and must remain attached to the session target.
  if (left && right && !/^\d+(?:\.\d+)?$/.test(right)) return right;
  return trimmed;
}

function stripFleetAndOracle(name: string): string {
  return name.toLowerCase().replace(/^\d+-/, "").replace(/-oracle$/i, "");
}

function legacyDashlessMatch(name: string, target: string): boolean {
  const t = target.toLowerCase();
  if (!t.includes("-")) return false;
  return stripFleetAndOracle(name).replace(/-/g, "") === stripFleetAndOracle(t).replace(/-/g, "");
}

/**
 * Try every reasonable name comparison: exact, slot-suffix
 * (`-${target}`), and dash-trimmed stem. Matches the conventions
 * established by sleep/done resolvers.
 *
 * #1342 — when `fuzzy` is true, also accept a case-insensitive substring
 * match (`n.includes(t)`). This is the second-pass mode used by
 * `cmdAttach` AFTER `maw wake <input>` has succeeded: wake fuzzy-resolved
 * the input (e.g. "wind" → "Somwind-oracle" → session "01-Somwind") but
 * doesn't surface the resolved name structurally, so the original input no
 * longer matches the freshly-created session under strict rules. Wake's
 * success implies a fuzzy match exists; loosening the comparator finds it.
 *
 * Strict mode (default) is preserved for every other caller — fuzzy is
 * opt-in and only enabled on the post-wake re-resolve callsite.
 */
function nameMatches(name: string, target: string, fuzzy: boolean = false): boolean {
  const n = name.toLowerCase();
  const t = target.toLowerCase();
  if (n === t || n.endsWith(`-${t}`) || n === `${t}-oracle` || n.endsWith(`-${t}-oracle`) || stripDash(n) === stripDash(t) || legacyDashlessMatch(n, t)) return true;
  if (fuzzy && t.length > 0 && n.includes(t)) return true;
  return false;
}

function windowMatchesOracle(windowName: string, target: string): boolean {
  const n = windowName.toLowerCase();
  const t = target.toLowerCase();
  return n === t || n === `${t}-oracle` || n.endsWith(`-${t}-oracle`);
}

function exactWindowName(session: SessionLike, target: string): string | undefined {
  const t = target.toLowerCase();
  return session.windows.find(w => w.name.toLowerCase() === t)?.name;
}

function runningMatchFor(session: SessionLike, target: string, fuzzy: boolean): { session: SessionLike; windowName?: string } | null {
  if (nameMatches(session.name, target, fuzzy)) return { session };
  const windowName = exactWindowName(session, target);
  if (windowName) return { session, windowName };
  if (session.windows.some(w => windowMatchesOracle(w.name, target))) return { session };
  return null;
}

export async function resolveAttachTarget(
  target: string,
  deps: ResolveDeps,
  opts: { fuzzy?: boolean } = {},
): Promise<ResolveResult> {
  target = normalizeAttachQuery(target);
  const fuzzy = Boolean(opts.fuzzy);
  const sessions = (await deps.listSessions())
    .filter(s => !isInfrastructureChannelSessionName(s.name, target));

  // Tier 1 — live tmux session/window matches.
  const runningMatches = sessions
    .map(s => runningMatchFor(s, target, fuzzy))
    .filter((s): s is { session: SessionLike; windowName?: string } => Boolean(s));
  if (runningMatches.length === 1) {
    const match = runningMatches[0];
    return {
      tier: 1,
      sessionName: match.session.name,
      ...(match.windowName ? { windowName: match.windowName } : {}),
    };
  }
  if (runningMatches.length > 1) {
    const exactSessionMatches = runningMatches.filter(
      match => match.session.name.toLowerCase() === target.toLowerCase(),
    );
    if (exactSessionMatches.length === 1) {
      const match = exactSessionMatches[0];
      return {
        tier: 1,
        sessionName: match.session.name,
        ...(match.windowName ? { windowName: match.windowName } : {}),
      };
    }
    return {
      tier: 1,
      sessionName: runningMatches[0].session.name,
      ambiguousCandidates: runningMatches.map(s => s.session.name),
    };
  }

  // Tier 1b — fleet window/repo aliases can still resolve custom sessions
  // when the visible tmux window name is generic but metadata carries the
  // oracle repo (#1807/#1812). Keep this after normal matching so a canonical
  // session plus an alias session is surfaced as ambiguity, not silently
  // narrowed to the alias.
  const windowAlias = resolveFleetWindowSessionTarget(target, sessions);
  if (windowAlias.kind === "fuzzy" || windowAlias.kind === "exact") {
    return { tier: 1, sessionName: windowAlias.match.name };
  }
  if (windowAlias.kind === "ambiguous") {
    return {
      tier: 1,
      sessionName: windowAlias.candidates[0].name,
      ambiguousCandidates: windowAlias.candidates.map(s => s.name),
    };
  }

  // Tier 2 — fleet-registered, sleeping.
  const fleet = deps.loadFleet();
  const fleetMatches = fleet.filter(f => nameMatches(f.name, target, fuzzy));
  if (fleetMatches.length === 1) {
    return { tier: 2, fleetName: fleetMatches[0].name };
  }
  if (fleetMatches.length > 1) {
    return {
      tier: 2,
      fleetName: fleetMatches[0].name,
      ambiguousCandidates: fleetMatches.map(f => f.name),
    };
  }

  return null;
}
