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
});
