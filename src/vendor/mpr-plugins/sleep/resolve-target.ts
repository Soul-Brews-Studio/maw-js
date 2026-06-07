/**
 * Resolve a `maw sleep <target>` invocation into a (session, window) tuple.
 *
 * Three-tier search (mirrors `maw done`'s resolver — see `done/impl.ts:30-37`):
 *   1. Window-name match across ALL sessions
 *      → handles worktree windows that are NOT in fleet (e.g. discord-awaken)
 *   2. Session-name match → fleet's primary window (or session's first)
 *      → handles slot-prefixed input ("29-arra-oracle-skills-cli")
 *      → handles stem-already-has-`-oracle` ("24-discord-oracle")
 *   3. detectSession (fleet-aware resolver) → fleet's primary window
 *      → handles stem-only input via fleet config lookup
 *
 * Replaces the string-build `${oracle}-oracle` approach (#1181 / PR #17),
 * which failed for Pattern B sessions and never knew about worktree windows.
 *
 * Deps are injected for testability (#1182).
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
  detectSession: (oracle: string) => Promise<string | null>;
}

export interface ResolveResult {
  session: string;
  window: string;
}

const stripDash = (s: string) => s.replace(/-+$/, "");

export async function resolveSleepTarget(
  target: string,
  windowOverride: string | undefined,
  deps: ResolveDeps,
): Promise<ResolveResult | null> {
  const targetLower = target.toLowerCase();
  const sessions = await deps.listSessions();

  // Tier 1: window-name match across ALL sessions.
  // Handles worktree windows (created by `maw wake --task` / `maw workon`)
  // that don't appear in fleet config.
  if (!windowOverride) {
    for (const s of sessions) {
      const w = s.windows.find(
        w =>
          w.name.toLowerCase() === targetLower ||
          stripDash(w.name).toLowerCase() === stripDash(targetLower),
      );
      if (w) return { session: s.name, window: w.name };
    }
  }

  // Tier 2: session-name match → fleet primary (or session's first window).
  // Handles slot-prefixed full session names ("29-arra-oracle-skills-cli")
  // and stem-suffix matches ("metis" → "22-metis").
  const sess = sessions.find(
    s =>
      s.name === target ||
      s.name.endsWith(`-${target}`) ||
      stripDash(s.name) === stripDash(target),
  );
  if (sess) {
    const fleet = deps.loadFleet().find(e => e.name === sess.name);
    const primary =
      windowOverride ??
      fleet?.windows[0]?.name ??
      sess.windows[0]?.name;
    if (primary) return { session: sess.name, window: primary };
  }

  // Tier 3: detectSession (the existing fleet-aware resolver in maw-js).
  // Handles stem-only input ("neo" → "01-neo" via fleet lookup).
  const session = await deps.detectSession(target);
  if (session) {
    const fleet = deps.loadFleet().find(e => e.name === session);
    if (windowOverride) {
      return { session, window: windowOverride };
    }
    if (fleet?.windows[0]?.name) {
      return { session, window: fleet.windows[0].name };
    }
    // No fleet entry → fall back to first tmux window in session.
    const sessInfo = sessions.find(s => s.name === session);
    if (sessInfo?.windows[0]?.name) {
      return { session, window: sessInfo.windows[0].name };
    }
  }

  return null;
}
