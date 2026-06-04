/**
 * Tests for detectWindowMismatch() — #1980 silent-misdelivery guard.
 *
 * Reproduces the federation failure where `maw hey oracle-world-oracle:mawjs-oracle`
 * forwarded `mawjs-oracle` to the peer, which resolved it to a bare `mawjs` shell
 * pane (`mawjs:0`) instead of the real `mawjs-oracle` window (`01-mawjs:1`) — yet
 * still reported `delivered`. See: #1980.
 */
import { describe, test, expect } from "bun:test";
import { detectWindowMismatch } from "../src/core/routing";
import type { Session } from "../src/core/runtime/find-window";

// The receiving node's landscape from the bug report: a bare `mawjs` session
// whose window 0 is a zsh shell named `mawjs`, plus the real oracle window.
const SESSIONS: Session[] = [
  { name: "mawjs", windows: [{ index: 0, name: "mawjs", active: true }] },
  { name: "01-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
];

describe("detectWindowMismatch (#1980)", () => {
  test("warns when an -oracle target lands on a non-oracle window", () => {
    const warning = detectWindowMismatch("mawjs-oracle", "mawjs:0", SESSIONS);
    expect(warning).not.toBeNull();
    expect(warning).toContain("mawjs:0");
    expect(warning).toContain("mawjs-oracle");
    expect(warning).toContain("wrong pane");
  });

  test("no warning when the -oracle target lands on the real oracle window", () => {
    expect(detectWindowMismatch("mawjs-oracle", "01-mawjs:1", SESSIONS)).toBeNull();
  });

  test("explicit session:index form bypasses the check (full-form escape hatch)", () => {
    expect(detectWindowMismatch("mawjs:0", "mawjs:0", SESSIONS)).toBeNull();
    expect(detectWindowMismatch("01-mawjs:1", "01-mawjs:1", SESSIONS)).toBeNull();
  });

  test("bare session alias resolving to its -oracle window is not flagged", () => {
    // `mawjs` (no -oracle suffix) → `mawjs-oracle` window is the intended
    // convention, not a misroute.
    expect(detectWindowMismatch("mawjs", "01-mawjs:1", SESSIONS)).toBeNull();
  });

  test("matches the oracle window even with an NN- session prefix on the window name", () => {
    const sessions: Session[] = [
      { name: "77-mawjs", windows: [{ index: 2, name: "77-mawjs-oracle", active: true }] },
    ];
    expect(detectWindowMismatch("mawjs-oracle", "77-mawjs:2", sessions)).toBeNull();
  });

  test("pane-addressed targets are parsed and checked", () => {
    expect(detectWindowMismatch("mawjs-oracle", "mawjs:0.1", SESSIONS)).not.toBeNull();
  });

  test("returns null when the resolved session/window cannot be found", () => {
    expect(detectWindowMismatch("mawjs-oracle", "ghost:9", SESSIONS)).toBeNull();
  });

  test("empty query is a no-op", () => {
    expect(detectWindowMismatch("", "mawjs:0", SESSIONS)).toBeNull();
  });
});
