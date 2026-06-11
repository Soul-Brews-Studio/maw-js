import { describe, test, expect } from "bun:test";
import {
  shouldRehydrateWorktrees,
  planRehydrateWorktreeWindows,
} from "../src/commands/shared/wake-cmd-helpers";
import { buildCommandInDir } from "../src/config";

/**
 * thread #14 — `maw wake <role>` must NOT fan out a `<role>-<wt-suffix>` window
 * per worktree on disk (the 17-window explosion + cross-role `--continue`
 * resume incident, 2026-06-11). Per-worktree rehydration is now OPT-IN
 * (default OFF); owner GO 2026-06-11.
 */

describe("F1 — per-worktree respawn is opt-in (default OFF)", () => {
  test("plain wake (no flag, no config) → rehydration OFF → 0 respawns", () => {
    expect(shouldRehydrateWorktrees({}, {})).toBe(false);
    expect(shouldRehydrateWorktrees({ respawnWorktrees: false }, { respawnWorktrees: false })).toBe(false);
  });

  test("opt-in via --respawn-worktrees → ON", () => {
    expect(shouldRehydrateWorktrees({ respawnWorktrees: true }, {})).toBe(true);
  });

  test("opt-in via fleet config respawnWorktrees:true → ON", () => {
    expect(shouldRehydrateWorktrees({}, { respawnWorktrees: true })).toBe(true);
  });

  test("--no-rehydrate / --main / --solo overrides the opt-in → OFF", () => {
    expect(shouldRehydrateWorktrees({ respawnWorktrees: true, noRehydrate: true }, { respawnWorktrees: true })).toBe(false);
  });
});

describe("F1 — when opted IN, the plan still scopes (own-name + collision skip)", () => {
  const WTS = [
    { name: "2-adr", path: "/r.wt-2-adr" },
    { name: "c-p2pmode", path: "/r.wt-c-p2pmode" },
    { name: "next-pm", path: "/r.wt-next-pm" }, // the role's own-name worktree
  ];

  test("one window per worktree, the role's own-name worktree is skipped", () => {
    const plan = planRehydrateWorktreeWindows("next-pm", WTS, []);
    expect(plan.length).toBe(2); // next-pm own-name worktree dropped
    expect(plan.every(p => p.windowName.startsWith("next-pm-"))).toBe(true);
    expect(plan.some(p => p.worktreeName === "next-pm")).toBe(false);
  });

  test("a worktree whose window already exists is skipped (collision)", () => {
    const first = planRehydrateWorktreeWindows("next-pm", WTS, []);
    const existing = first.map(p => p.windowName);
    const second = planRehydrateWorktreeWindows("next-pm", WTS, existing);
    expect(second.length).toBe(0);
  });
});

describe("F2 — a rehydrated (fresh) worktree pane never bare-`--continue`s", () => {
  test("buildCommandInDir with fresh=true emits no `--continue`", () => {
    const cmd = buildCommandInDir("next-pm-adr", "/tmp/maw-test-nonexistent-cwd-f2", { fresh: true });
    expect(cmd).not.toContain("--continue");
  });
});
