import { describe, test, expect } from "bun:test";
// Import from ../src/find-window directly — NOT from ../src/ssh.
// Other test files call mock.module("../src/ssh") which globally
// replaces the ssh module, breaking findWindow for anyone importing
// from there. The real implementation lives in find-window.ts which
// no test mocks, so imports here stay stable.
import { findWindow } from "../src/find-window";
import type { Session } from "../src/find-window";

const MOCK_SESSIONS: Session[] = [
  {
    name: "1-oracles",
    windows: [
      { index: 0, name: "neo-oracle", active: true },
      { index: 1, name: "pulse-oracle", active: false },
      { index: 2, name: "hermes-oracle", active: false },
      { index: 3, name: "nexus-oracle", active: false },
    ],
  },
  {
    name: "0",
    windows: [
      { index: 0, name: "claude", active: true },
    ],
  },
  {
    name: "3-brewing",
    windows: [
      { index: 0, name: "xiaoer", active: true },
      { index: 1, name: "maeon", active: false },
    ],
  },
];

describe("findWindow", () => {
  test("finds by window name substring", () => {
    expect(findWindow(MOCK_SESSIONS, "neo")).toBe("1-oracles:neo-oracle");
  });

  test("finds case-insensitive", () => {
    expect(findWindow(MOCK_SESSIONS, "NEO")).toBe("1-oracles:neo-oracle");
    expect(findWindow(MOCK_SESSIONS, "Pulse")).toBe("1-oracles:pulse-oracle");
  });

  test("finds across sessions", () => {
    expect(findWindow(MOCK_SESSIONS, "claude")).toBe("0:claude");
    expect(findWindow(MOCK_SESSIONS, "xiaoer")).toBe("3-brewing:xiaoer");
  });

  test("returns null for no match", () => {
    expect(findWindow(MOCK_SESSIONS, "nonexistent")).toBeNull();
  });

  test("returns target string as-is if it contains colon", () => {
    expect(findWindow(MOCK_SESSIONS, "1-oracles:2")).toBe("1-oracles:2");
  });

  test("partial match works", () => {
    expect(findWindow(MOCK_SESSIONS, "herm")).toBe("1-oracles:hermes-oracle");
  });

  test("returns first match when multiple match", () => {
    // "oracle" matches all in 1-oracles session
    expect(findWindow(MOCK_SESSIONS, "oracle")).toBe("1-oracles:neo-oracle");
  });

  describe("session:window syntax (#186)", () => {
    const MAW_SESSIONS: Session[] = [
      { name: "08-mawjs", windows: [
        { index: 1, name: "mawjs-oracle", active: true },
        { index: 2, name: "mawjs-dev", active: false },
      ]},
      { name: "13-mother", windows: [
        { index: 1, name: "mother-oracle", active: true },
      ]},
      { name: "mawjs-view", windows: [
        { index: 1, name: "mawjs-oracle", active: false },
      ]},
    ];

    test("full session name + full window name", () => {
      expect(findWindow(MAW_SESSIONS, "08-mawjs:mawjs-oracle"))
        .toBe("08-mawjs:mawjs-oracle");
    });

    test("oracle short name resolves to NN-prefixed session, not substring collision", () => {
      // 'mawjs' must NOT route to 'mawjs-view' — it should hit '08-mawjs'
      // because 'mawjs' is the oracle-name match (08-mawjs strip → mawjs).
      expect(findWindow(MAW_SESSIONS, "mawjs:mawjs-oracle"))
        .toBe("08-mawjs:mawjs-oracle");
    });

    test("oracle short name + window short name", () => {
      // 'mawjs:dev' → 08-mawjs:mawjs-dev (substring on window)
      expect(findWindow(MAW_SESSIONS, "mawjs:dev"))
        .toBe("08-mawjs:mawjs-dev");
    });

    test("short name targets 13-mother not other sessions", () => {
      expect(findWindow(MAW_SESSIONS, "mother:mother-oracle"))
        .toBe("13-mother:mother-oracle");
    });

    test("empty window part returns session's first window", () => {
      expect(findWindow(MAW_SESSIONS, "08-mawjs:"))
        .toBe("08-mawjs:mawjs-oracle");
    });

    test("exact session name beats oracle-name match", () => {
      // 'mawjs-view' is an exact session name; should match it directly,
      // not 08-mawjs (which would be the oracle-name match for 'mawjs').
      expect(findWindow(MAW_SESSIONS, "mawjs-view:mawjs-oracle"))
        .toBe("mawjs-view:mawjs-oracle");
    });

    test("falls through to legacy logic when session part doesn't match", () => {
      // 'nosession:foo' → matchSession returns null → fall through →
      // legacy step 3 returns query as-is (preserves old behavior).
      expect(findWindow(MAW_SESSIONS, "nosession:foo"))
        .toBe("nosession:foo");
    });

    test("falls through when session matches but window part doesn't", () => {
      // 'mawjs:nowindow' → matches 08-mawjs but no window matches.
      // Falls through to legacy substring match (which won't find it),
      // ending at the colon-fallback.
      expect(findWindow(MAW_SESSIONS, "mawjs:nowindow"))
        .toBe("mawjs:nowindow");
    });
  });
});
