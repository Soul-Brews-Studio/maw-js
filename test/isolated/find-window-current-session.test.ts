import { describe, expect, test } from "bun:test";
import { AmbiguousMatchError, findWindow, type Session } from "../../src/core/runtime/find-window";

const SESSIONS: Session[] = [
  {
    name: "89-mawjs",
    windows: [
      { index: 1, name: "mawjs-oracle", active: true },
      { index: 2, name: "mawjs-codex-1", active: false },
    ],
  },
  {
    name: "46-atlas",
    windows: [
      { index: 1, name: "atlas-oracle", active: true },
      { index: 2, name: "atlas-codex-1", active: false },
    ],
  },
  {
    name: "12-sidecar",
    windows: [
      { index: 1, name: "sidecar-codex-2", active: true },
    ],
  },
];

describe("findWindow current-session scoped substring pass (#2134)", () => {
  test("bare name matching one window in current session resolves without cross-session ambiguity", () => {
    expect(findWindow(SESSIONS, "codex-1", "89-mawjs")).toBe("89-mawjs:2");
  });

  test("bare name matching zero windows in current session falls through to one cross-session match", () => {
    expect(findWindow(SESSIONS, "codex-2", "89-mawjs")).toBe("12-sidecar:1");
  });

  test("bare name matching multiple windows in current session is ambiguous within current session", () => {
    const sessions: Session[] = [
      {
        name: "89-mawjs",
        windows: [
          { index: 1, name: "mawjs-codex-1", active: true },
          { index: 2, name: "mawjs-helper-codex-1", active: false },
        ],
      },
      {
        name: "46-atlas",
        windows: [
          { index: 1, name: "atlas-codex-1", active: true },
        ],
      },
    ];

    expect(() => findWindow(sessions, "codex-1", "89-mawjs")).toThrow(AmbiguousMatchError);
    try {
      findWindow(sessions, "codex-1", "89-mawjs");
    } catch (error) {
      const err = error as AmbiguousMatchError;
      expect(err.candidates).toEqual(["89-mawjs:1", "89-mawjs:2"]);
    }
  });

  test("without currentSession preserves existing cross-session ambiguity behavior", () => {
    expect(() => findWindow(SESSIONS, "codex-1")).toThrow(AmbiguousMatchError);
  });

  test("ignores maw-pty-* mirror sessions when resolving target window", () => {
    const sessionsWithPty: Session[] = [
      {
        name: "signaltale",
        windows: [
          { index: 1, name: "st-orchestrator", active: false },
          { index: 3, name: "st-oracle-oracle", active: true },
        ],
      },
      {
        name: "maw-pty-1788431581662-16",
        windows: [
          { index: 1, name: "st-orchestrator", active: false },
          { index: 3, name: "st-oracle-oracle", active: true },
        ],
      },
    ];

    expect(findWindow(sessionsWithPty, "st-oracle-oracle")).toBe("signaltale:3");
    expect(findWindow(sessionsWithPty, "signaltale:st-oracle-oracle")).toBe("signaltale:3");
  });

  test("allows explicit query by maw-pty- session name", () => {
    const sessionsWithPty: Session[] = [
      {
        name: "maw-pty-1788431581662-16",
        windows: [
          { index: 3, name: "st-oracle-oracle", active: true },
        ],
      },
    ];

    expect(findWindow(sessionsWithPty, "maw-pty-1788431581662-16:3")).toBe("maw-pty-1788431581662-16:3");
  });
});
