import { describe, expect, test } from "bun:test";
import { planRehydrateWorktreeWindows } from "../../src/commands/shared/wake-cmd";

describe("planRehydrateWorktreeWindows (#1563)", () => {
  const worktrees = [
    { name: "1-alpha", path: "/repo.wt-1-alpha" },
    { name: "2-alpha", path: "/repo.wt-2-alpha" },
    { name: "3-beta", path: "/repo.wt-3-beta" },
  ];

  test("plans stable de-numbered window names and numbered fallback for true collisions", () => {
    const planned = planRehydrateWorktreeWindows("mawjs", worktrees);
    expect(planned.map(p => p.windowName)).toEqual(["mawjs-alpha", "mawjs-2-alpha", "mawjs-beta"]);
  });

  test("skips existing windows and live tile roles before respawn", () => {
    const planned = planRehydrateWorktreeWindows(
      "mawjs",
      worktrees,
      ["mawjs-alpha"],
      new Set(["beta"]),
    );
    expect(planned.map(p => p.windowName)).toEqual([]);
  });

  test("skips same-name orphan-style worktree names instead of planning oracle-oracle ghosts (#2375)", () => {
    const planned = planRehydrateWorktreeWindows("athena", [
      { name: "athena", path: "/repo/agents/athena" },
      { name: "1-athena", path: "/repo/agents/1-athena" },
      { name: "2-fix", path: "/repo/agents/2-fix" },
    ]);

    expect(planned.map(p => p.windowName)).toEqual(["athena-fix"]);
  });

  test("strips oracle-prefixed worktree task names before composing wake window names (#2375)", () => {
    const planned = planRehydrateWorktreeWindows("athena", [
      { name: "1-athena-codex-1", path: "/repo/agents/1-athena-codex-1" },
      { name: "2-athena-codex-1", path: "/repo/agents/2-athena-codex-1" },
      { name: "3-athena-review", path: "/repo/agents/3-athena-review" },
    ]);

    expect(planned.map(p => p.windowName)).toEqual(["athena-codex-1", "athena-2-codex-1", "athena-review"]);
  });

});
