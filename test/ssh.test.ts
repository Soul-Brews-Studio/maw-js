import { describe, test, expect } from "bun:test";
import { findWindow } from "../src/ssh";
import type { Session } from "../src/ssh";

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

  test("returns first match when multiple match", () => {
    // "oracle" matches all in 1-oracles session
    expect(findWindow(MOCK_SESSIONS, "oracle")).toBe("1-oracles:0");
  });
});
