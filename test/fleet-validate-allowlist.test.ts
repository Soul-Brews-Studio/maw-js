/**
 * Tests for #1134 — `maw fleet validate` orphan-allowlist match logic.
 *
 * Replicates the matching rule from src/commands/shared/fleet-validate.ts
 * inline (same pattern as wake.test.ts) so we don't pull in tmux/fs/config
 * module chains. The rule is small enough to keep in sync.
 */
import { describe, test, expect } from "bun:test";

// Replicates the match logic from fleet-validate.ts:
//   const stem = s.replace(/^\d+-/, "");
//   if (allowlist.has(s) || allowlist.has(stem)) continue;
function isAllowlisted(session: string, allowlist: string[]): boolean {
  const set = new Set(allowlist);
  if (set.has(session)) return true;
  const stem = session.replace(/^\d+-/, "");
  return set.has(stem);
}

describe("fleetValidateAllowlist match (#1134)", () => {
  test("exact session-name match", () => {
    expect(isAllowlisted("08-mawjs", ["08-mawjs"])).toBe(true);
  });

  test("matches stem after NN- slot prefix strip", () => {
    // The whole point: slot prefixes shift between renumberings, so listing
    // 'mawjs' should cover the oracle no matter what slot it's in.
    expect(isAllowlisted("08-mawjs", ["mawjs"])).toBe(true);
    expect(isAllowlisted("25-mawjs", ["mawjs"])).toBe(true);
  });

  test("does NOT match unrelated session", () => {
    expect(isAllowlisted("12-pulse", ["mawjs"])).toBe(false);
  });

  test("stem-match is exact, not prefix — `mawjs` does not allow `mawjs-2`", () => {
    // Session "09-mawjs-2" has stem "mawjs-2" (not "mawjs"). The allowlist
    // entry "mawjs" must NOT inadvertently cover the related-but-distinct
    // session — operator must list it explicitly.
    expect(isAllowlisted("09-mawjs-2", ["mawjs"])).toBe(false);
    expect(isAllowlisted("09-mawjs-2", ["mawjs-2"])).toBe(true);
  });

  test("session without NN- prefix matches only exactly", () => {
    expect(isAllowlisted("custom-session", ["custom-session"])).toBe(true);
    expect(isAllowlisted("custom-session", ["custom-other"])).toBe(false);
  });

  test("empty allowlist matches nothing", () => {
    expect(isAllowlisted("08-mawjs", [])).toBe(false);
  });

  test("multi-entry allowlist", () => {
    const allow = ["mawjs", "mawui", "pulse"];
    expect(isAllowlisted("08-mawjs", allow)).toBe(true);
    expect(isAllowlisted("25-mawui", allow)).toBe(true);
    expect(isAllowlisted("12-pulse", allow)).toBe(true);
    expect(isAllowlisted("31-odin", allow)).toBe(false);
  });
});
