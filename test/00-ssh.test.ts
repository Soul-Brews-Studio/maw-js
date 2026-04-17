import { describe, test, expect } from "bun:test";
// Import from ../src/find-window directly — NOT from ../src/ssh.
// Other test files call mock.module("../src/core/transport/ssh") which globally
// replaces the ssh module, breaking findWindow for anyone importing
// from there. The real implementation lives in find-window.ts which
// no test mocks, so imports here stay stable.
import { findWindow, AmbiguousMatchError } from "../src/core/runtime/find-window";
import type { Session } from "../src/core/runtime/find-window";

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
    expect(findWindow(MOCK_SESSIONS, "neo")).toBe("1-oracles:0");
  });

  test("finds case-insensitive", () => {
    expect(findWindow(MOCK_SESSIONS, "NEO")).toBe("1-oracles:0");
    expect(findWindow(MOCK_SESSIONS, "Pulse")).toBe("1-oracles:1");
  });

  test("finds across sessions", () => {
    expect(findWindow(MOCK_SESSIONS, "claude")).toBe("0:0");
    expect(findWindow(MOCK_SESSIONS, "xiaoer")).toBe("3-brewing:0");
  });

  test("returns null for no match", () => {
    expect(findWindow(MOCK_SESSIONS, "nonexistent")).toBeNull();
  });

  test("returns target string as-is if it contains colon", () => {
    expect(findWindow(MOCK_SESSIONS, "1-oracles:2")).toBe("1-oracles:2");
  });

  test("partial match works", () => {
    expect(findWindow(MOCK_SESSIONS, "herm")).toBe("1-oracles:2");
  });

  test("throws AmbiguousMatchError when multiple substring matches and no exact (#414)", () => {
    // "oracle" substring-matches 4 windows (neo/pulse/hermes/nexus-oracle) with no
    // exact hit. Pre-#414 this silently picked the first; now it must error.
    expect(() => findWindow(MOCK_SESSIONS, "oracle")).toThrow(AmbiguousMatchError);
    try {
      findWindow(MOCK_SESSIONS, "oracle");
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousMatchError);
      const err = e as AmbiguousMatchError;
      expect(err.query).toBe("oracle");
      expect(err.candidates.length).toBeGreaterThanOrEqual(2);
    }
  });

  describe("exact-match-first bare resolution (#414 / #406-1a)", () => {
    const MOTHER_SESSIONS: Session[] = [
      { name: "109-mother-roots", windows: [
        { index: 1, name: "mother-roots-oracle", active: true },
      ]},
      { name: "13-mother", windows: [
        { index: 1, name: "mother-oracle", active: true },
      ]},
      { name: "mother-view", windows: [
        { index: 1, name: "view", active: true },
      ]},
    ];

    test("bare 'mother' single exact oracle-name match resolves (13-mother)", () => {
      // '13-mother' strips to 'mother' (oracle-name exact); '109-mother-roots'
      // strips to 'mother-roots' (no exact); 'mother-view' (no NN- prefix, no exact).
      // Pre-fix iteration order surfaced '109-mother-roots' via window substring.
      expect(findWindow(MOTHER_SESSIONS, "mother")).toBe("13-mother:1");
    });

    test("bare 'mother' still resolves when 109-mother-roots listed first", () => {
      // Guard against tmux list ordering (`13` < `109` lexical) — exact beats
      // iteration position.
      const reordered = [MOTHER_SESSIONS[0], MOTHER_SESSIONS[2], MOTHER_SESSIONS[1]];
      expect(findWindow(reordered, "mother")).toBe("13-mother:1");
    });

    test("bare 'foo' with only prefix/substring matches → AmbiguousMatchError", () => {
      const foo: Session[] = [
        { name: "101-foo-bar", windows: [{ index: 1, name: "foo-bar-oracle", active: true }] },
        { name: "102-foo-baz", windows: [{ index: 1, name: "foo-baz-oracle", active: true }] },
      ];
      expect(() => findWindow(foo, "foo")).toThrow(AmbiguousMatchError);
      try {
        findWindow(foo, "foo");
      } catch (e) {
        const err = e as AmbiguousMatchError;
        expect(err.candidates).toContain("101-foo-bar:1");
        expect(err.candidates).toContain("102-foo-baz:1");
      }
    });

    test("bare 'view' unique exact window-name match resolves", () => {
      // 'mother-view' session has a window literally named 'view'. Exact window
      // match is unique → resolves even though 'view' substring-hits mother-view
      // session name too (dedup keeps them consistent).
      expect(findWindow(MOTHER_SESSIONS, "view")).toBe("mother-view:1");
    });
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
        .toBe("08-mawjs:1");
    });

    test("oracle short name resolves to NN-prefixed session, not substring collision", () => {
      // 'mawjs' must NOT route to 'mawjs-view' — it should hit '08-mawjs'
      // because 'mawjs' is the oracle-name match (08-mawjs strip → mawjs).
      expect(findWindow(MAW_SESSIONS, "mawjs:mawjs-oracle"))
        .toBe("08-mawjs:1");
    });

    test("oracle short name + window short name", () => {
      // 'mawjs:dev' → 08-mawjs:mawjs-dev (substring on window)
      expect(findWindow(MAW_SESSIONS, "mawjs:dev"))
        .toBe("08-mawjs:2");
    });

    test("short name targets 13-mother not other sessions", () => {
      expect(findWindow(MAW_SESSIONS, "mother:mother-oracle"))
        .toBe("13-mother:1");
    });

    test("empty window part returns session's first window", () => {
      expect(findWindow(MAW_SESSIONS, "08-mawjs:"))
        .toBe("08-mawjs:1");
    });

    test("exact session name beats oracle-name match", () => {
      // 'mawjs-view' is an exact session name; should match it directly,
      // not 08-mawjs (which would be the oracle-name match for 'mawjs').
      expect(findWindow(MAW_SESSIONS, "mawjs-view:mawjs-oracle"))
        .toBe("mawjs-view:1");
    });

    test("returns null when session part doesn't match (enables federation fallback)", () => {
      // 'nosession:foo' → matchSession returns null → no local session →
      // return null so cmdSend falls through to node-prefix federation routing.
      // This is the fix for #176/#177 — "oracle-world:mawjs" was being returned
      // as a local target, bypassing federation.
      expect(findWindow(MAW_SESSIONS, "nosession:foo"))
        .toBeNull();
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
