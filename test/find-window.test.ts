/**
 * Tests for findWindow fallback at "session-matched, window-didn't" boundary.
 *
 * Guards the shadow regression where `oracle-world:100-pulse` (a remote
 * namedPeer + remote agent) silently matched local session `30-oracle-world`
 * via oracle-name strip and returned the raw query as a tmux target — causing
 * routing to skip peer Step 2 entirely. See: ship-routing-fix team task #1.
 */
import { describe, test, expect } from "bun:test";
import { findWindow, type Session } from "../src/core/runtime/find-window";

describe("findWindow — session-matched, window-not-matched fallback", () => {
  test("shadow case: oracle-world:100-pulse with local 30-oracle-world returns null (lets peer routing take over)", () => {
    const sessions: Session[] = [
      { name: "30-oracle-world", windows: [{ index: 1, name: "oracle-world-oracle", active: true }] },
    ];
    expect(findWindow(sessions, "oracle-world:100-pulse")).toBeNull();
  });

  test("numeric tmux index still resolves: mawjs:1 with local 01-mawjs returns raw query", () => {
    const sessions: Session[] = [
      { name: "01-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];
    expect(findWindow(sessions, "mawjs:1")).toBe("mawjs:1");
  });
});
