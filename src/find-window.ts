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
 * Match a session by name part. Tries (in order):
 *   1. Exact match
 *   2. Oracle-name match (strip leading `\d+-` from session name)
 *   3. Substring match
 * Returns the first session that matches, or null.
 */
function matchSession(sessions: Session[], part: string): Session | null {
  const p = part.toLowerCase();
  if (!p) return null;
  // 1. Exact
  for (const s of sessions) if (s.name.toLowerCase() === p) return s;
  // 2. Oracle-name (strip "NN-" prefix)
  for (const s of sessions) if (s.name.toLowerCase().replace(/^\d+-/, "") === p) return s;
  // 3. Substring
  for (const s of sessions) if (s.name.toLowerCase().includes(p)) return s;
  return null;
}

export function findWindow(sessions: Session[], query: string): string | null {
  const q = query.toLowerCase();

  // session:window syntax — substring-match each half semantically (#186)
  if (query.includes(":")) {
    const [sessPart, winPart] = q.split(":", 2);
    const sess = matchSession(sessions, sessPart);
    if (sess) {
      // Empty window part → return session's first window
      if (!winPart) {
        if (sess.windows.length > 0) return `${sess.name}:${sess.windows[0].name}`;
      } else {
        for (const w of sess.windows) {
          if (w.name.toLowerCase().includes(winPart)) return `${sess.name}:${w.name}`;
        }
      }
    }
    // Fall through if no semantic match
  }

  // Match window names first (most specific)
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.toLowerCase().includes(q)) return `${s.name}:${w.name}`;
    }
  }
  // Match session names — return first window of matching session
  for (const s of sessions) {
    if (s.name.toLowerCase().includes(q) && s.windows.length > 0) {
      return `${s.name}:${s.windows[0].name}`;
    }
  }
  if (query.includes(":")) return query;
  return null;
}
