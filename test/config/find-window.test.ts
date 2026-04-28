/**
 * Tests for findWindow and AmbiguousMatchError from src/core/runtime/find-window.ts.
 * Pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { findWindow, AmbiguousMatchError } from "../../src/core/runtime/find-window";
import type { Session } from "../../src/core/runtime/find-window";

function makeSessions(...items: Array<{ name: string; windows: Array<{ index: number; name: string }> }>): Session[] {
  return items.map(s => ({
    name: s.name,
    windows: s.windows.map(w => ({ ...w, active: false })),
  }));
}

describe("findWindow", () => {
  describe("exact match", () => {
    it("matches by exact window name", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "mawjs" }] });
      expect(findWindow(sessions, "mawjs")).toBe("08-mawjs:0");
    });

    it("matches by exact session name", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "win" }] });
      expect(findWindow(sessions, "08-mawjs")).toBe("08-mawjs:0");
    });

    it("matches by oracle-name (strip NN- prefix)", () => {
      const sessions = makeSessions({ name: "05-pulse", windows: [{ index: 0, name: "pulse-oracle" }] });
      expect(findWindow(sessions, "pulse")).toBe("05-pulse:0");
    });
  });

  describe("case insensitive", () => {
    it("matches window name case-insensitively", () => {
      const sessions = makeSessions({ name: "main", windows: [{ index: 0, name: "MawJS" }] });
      expect(findWindow(sessions, "mawjs")).toBe("main:0");
    });
  });

  describe("substring match", () => {
    it("matches by substring when no exact match", () => {
      const sessions = makeSessions({ name: "main", windows: [{ index: 2, name: "mawjs-debug" }] });
      expect(findWindow(sessions, "debug")).toBe("main:2");
    });

    it("matches session name by substring", () => {
      const sessions = makeSessions({ name: "08-mawjs-main", windows: [{ index: 0, name: "win" }] });
      expect(findWindow(sessions, "mawjs")).toBe("08-mawjs-main:0");
    });
  });

  describe("session:window syntax", () => {
    it("matches session:window with strict session match", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "debug" }] });
      expect(findWindow(sessions, "08-mawjs:debug")).toBe("08-mawjs:0");
    });

    it("returns first window when window part is empty", () => {
      const sessions = makeSessions({
        name: "08-mawjs",
        windows: [{ index: 0, name: "first" }, { index: 1, name: "second" }],
      });
      expect(findWindow(sessions, "08-mawjs:")).toBe("08-mawjs:0");
    });

    it("returns null when session:window syntax matches no session (falls to federation)", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "win" }] });
      // "oracle-world:mawjs" — session "oracle-world" doesn't exist → null (federation routing)
      expect(findWindow(sessions, "oracle-world:mawjs")).toBeNull();
    });

    it("returns raw query when session exists but window doesn't match", () => {
      const sessions = makeSessions({ name: "08-mawjs", windows: [{ index: 0, name: "main" }] });
      // Session "08-mawjs" exists but no window matches "nonexistent" — return raw query
      expect(findWindow(sessions, "08-mawjs:nonexistent")).toBe("08-mawjs:nonexistent");
    });

    it("uses strict matching for session part (no substring)", () => {
      const sessions = makeSessions({ name: "105-whitekeeper", windows: [{ index: 0, name: "keeper" }] });
      // "white:mawjs" — session part "white" should NOT match "105-whitekeeper" via substring
      expect(findWindow(sessions, "white:mawjs")).toBeNull();
    });
  });

  describe("ambiguous match error", () => {
    it("throws AmbiguousMatchError when multiple exact matches", () => {
      const sessions = makeSessions(
        { name: "main", windows: [{ index: 0, name: "pulse" }] },
        { name: "05-pulse", windows: [{ index: 0, name: "other" }] },
      );
      // "pulse" matches: window "pulse" in main AND session "05-pulse" (stripped oracle-name)
      expect(() => findWindow(sessions, "pulse")).toThrow(AmbiguousMatchError);
    });

    it("AmbiguousMatchError has query and candidates", () => {
      const sessions = makeSessions(
        { name: "main", windows: [{ index: 0, name: "agent" }] },
        { name: "dev", windows: [{ index: 0, name: "agent" }] },
      );
      try {
        findWindow(sessions, "agent");
        expect(true).toBe(false); // should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(AmbiguousMatchError);
        const err = e as AmbiguousMatchError;
        expect(err.query).toBe("agent");
        expect(err.candidates).toHaveLength(2);
      }
    });

    it("throws for multiple substring matches too", () => {
      const sessions = makeSessions(
        { name: "main", windows: [{ index: 0, name: "neo-alpha" }] },
        { name: "dev", windows: [{ index: 0, name: "neo-beta" }] },
      );
      expect(() => findWindow(sessions, "neo")).toThrow(AmbiguousMatchError);
    });
  });

  describe("no match", () => {
    it("returns null when nothing matches", () => {
      const sessions = makeSessions({ name: "main", windows: [{ index: 0, name: "agent" }] });
      expect(findWindow(sessions, "nonexistent")).toBeNull();
    });

    it("returns null for empty sessions", () => {
      expect(findWindow([], "anything")).toBeNull();
    });

    it("returns null for session with no windows", () => {
      const sessions = makeSessions({ name: "main", windows: [] });
      expect(findWindow(sessions, "main")).toBeNull();
    });
  });

  describe("priority", () => {
    it("exact match wins over substring", () => {
      const sessions = makeSessions({
        name: "main",
        windows: [
          { index: 0, name: "neo-extended" },
          { index: 1, name: "neo" },
        ],
      });
      // "neo" is exact match for index 1, substring of index 0
      expect(findWindow(sessions, "neo")).toBe("main:1");
    });
  });
});

describe("AmbiguousMatchError", () => {
  it("has correct name", () => {
    const err = new AmbiguousMatchError("test", ["a", "b"]);
    expect(err.name).toBe("AmbiguousMatchError");
  });

  it("includes query in message", () => {
    const err = new AmbiguousMatchError("test", ["a", "b"]);
    expect(err.message).toContain("test");
  });

  it("includes candidates in message", () => {
    const err = new AmbiguousMatchError("test", ["a", "b"]);
    expect(err.message).toContain("a");
    expect(err.message).toContain("b");
  });

  it("is instance of Error", () => {
    expect(new AmbiguousMatchError("x", [])).toBeInstanceOf(Error);
  });
});
