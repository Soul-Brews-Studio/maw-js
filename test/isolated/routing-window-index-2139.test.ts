import { describe, expect, test } from "bun:test";

import { findWindow, type Session } from "../../src/core/runtime/find-window";
import { resolveTarget } from "../../src/core/routing";

const CONFIG = { node: "m5", namedPeers: [], peers: [], agents: {} } as any;

const ATLAS: Session[] = [
  {
    name: "01-atlas",
    windows: [
      { index: 1, name: "atlas-oracle", active: false },
      { index: 2, name: "discord-atlas-codex", active: true },
      { index: 3, name: "discord-atlas-codex-2", active: false },
    ],
  },
];

describe("routing explicit session window indexes (#2139)", () => {
  test("findWindow resolves session:number against tmux window_index without +1", () => {
    expect(findWindow(ATLAS, "atlas:2")).toBe("01-atlas:2");
    expect(findWindow(ATLAS, "01-atlas:2.0")).toBe("01-atlas:2.0");
  });

  test("resolveTarget validates numeric session aliases before raw tmux fallback", () => {
    expect(resolveTarget("atlas:2", CONFIG, ATLAS)).toEqual({ type: "local", target: "01-atlas:2" });
    expect(resolveTarget("01-atlas:2", CONFIG, ATLAS)).toEqual({ type: "local", target: "01-atlas:2" });
  });

  test("resolveTarget refuses a missing numeric window instead of passing raw target to tmux", () => {
    expect(resolveTarget("atlas:4", CONFIG, ATLAS)).toMatchObject({
      type: "error",
      reason: "session_window_index_not_found",
    });
  });
});
