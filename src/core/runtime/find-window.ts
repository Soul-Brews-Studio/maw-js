/**
 * Pure session/window resolution logic.
 *
 * This module exists as a separate file (rather than living inside ssh.ts)
 * specifically so tests can import it without being affected by mock.module()
 * calls that replace "../src/ssh" across the test suite. Bun's mock.module()
 * is global — once any test file mocks ssh, every subsequent test that
 * imports from ssh gets the stub. Extracting findWindow here gives us a
 * clean import path that mocks can't touch.
 *
 * See: test/engine.test.ts:10 comment and the fix in #198.
 */

export interface Window {
  index: number;
  name: string;
  active: boolean;
}

export interface Session {
  name: string;
  windows: Window[];
}

/**
 * Thrown when a bare-name query matches multiple candidates and no exact
 * match can disambiguate. See #414 / #406-1a.
 */
export class AmbiguousMatchError extends Error {
  readonly query: string;
  readonly candidates: string[];
  constructor(query: string, candidates: string[]) {
    super(`Ambiguous match for "${query}" — candidates: ${candidates.join(", ")}`);
    this.name = "AmbiguousMatchError";
    this.query = query;
    this.candidates = candidates;
  }
}

/**
 * Match a session by name part. Tries (in order):
 *   1. Exact match
 *   2. Oracle-name match (strip leading `\d+-` from session name)
 *   3. Substring match
 * Returns the first session that matches, or null.
 */
function matchSession(sessions: Session[], part: string, strict = false): Session | null {
  const p = part.toLowerCase();
  if (!p) return null;
  // 1. Exact
  for (const s of sessions) if (s.name.toLowerCase() === p) return s;
  // 2. Oracle-name (strip "NN-" prefix)
  for (const s of sessions) if (s.name.toLowerCase().replace(/^\d+-/, "") === p) return s;
  // 3. Substring (skip in strict mode — prevents "white" matching "whitekeeper")
  if (!strict) {
    for (const s of sessions) if (s.name.toLowerCase().includes(p)) return s;
  }
  return null;
}

export function findWindow(sessions: Session[], query: string): string | null {
  const q = query.toLowerCase();

  // session:window syntax — strict session match to prevent node:agent collision (#186)
  // "white:mawjs" must NOT match "105-whitekeeper" via substring
  if (query.includes(":")) {
    const [sessPart, winPart] = q.split(":", 2);
    const sess = matchSession(sessions, sessPart, true);
    if (sess) {
      // Empty window part → return session's first window
      if (!winPart) {
        if (sess.windows.length > 0) return `${sess.name}:${sess.windows[0].index}`;
      } else {
        for (const w of sess.windows) {
          if (w.name.toLowerCase().includes(winPart)) return `${sess.name}:${w.index}`;
        }
      }
    }
    // Fall through if no semantic match
  }

  // Two-pass bare-name resolution (#414):
  //   Pass 1 collects exact matches (window name, session name, stripped
  //   oracle-name). Pass 2 collects substring matches only if Pass 1 was
  //   empty. Multi-candidate in either pass → AmbiguousMatchError.
  const exact = new Set<string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.toLowerCase() === q) exact.add(`${s.name}:${w.index}`);
    }
    if (s.windows.length > 0) {
      const sn = s.name.toLowerCase();
      if (sn === q || sn.replace(/^\d+-/, "") === q) {
        exact.add(`${s.name}:${s.windows[0].index}`);
      }
    }
  }
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) throw new AmbiguousMatchError(query, [...exact]);

  const sub = new Set<string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.toLowerCase().includes(q)) sub.add(`${s.name}:${w.index}`);
    }
    if (s.name.toLowerCase().includes(q) && s.windows.length > 0) {
      sub.add(`${s.name}:${s.windows[0].index}`);
    }
  }
  if (sub.size === 1) return [...sub][0];
  if (sub.size > 1) throw new AmbiguousMatchError(query, [...sub]);
  // If query has ":" and the SESSION part matched a real session but the
  // WINDOW part didn't → return raw query (user may mean index, e.g. "08-mawjs:1").
  // If the SESSION part didn't match anything local → return null so cmdSend
  // falls through to federation routing (node:agent like "oracle-world:mawjs").
  if (query.includes(":")) {
    const [sessPart] = query.toLowerCase().split(":", 2);
    const sessExists = matchSession(sessions, sessPart, true);
    return sessExists ? query : null;
  }
  return null;
}
