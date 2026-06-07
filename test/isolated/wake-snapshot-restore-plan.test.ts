/**
 * #1576 — wake snapshot restore planning.
 *
 * Restore is intentionally conservative: snapshots only know window names, so
 * the planner recreates missing windows and chooses a worktree cwd only when
 * the window name can be mapped back to an existing worktree.
 */
import { describe, expect, test } from "bun:test";
import {
  findWakeSnapshotSession,
  planSnapshotRestoreWindows,
} from "../../src/commands/shared/wake-cmd";
import type { Snapshot } from "../../src/core/fleet/snapshot";

const snapshot: Snapshot = {
  timestamp: "2026-05-16T11:00:00.000Z",
  trigger: "wake",
  node: "m5",
  sessions: [
    { name: "54-mawjs", windows: [{ name: "mawjs-oracle" }, { name: "mawjs-feature-a" }] },
    { name: "discord", windows: [{ name: "discord-oracle" }] },
  ],
};

describe("wake --from-snapshot planning (#1576)", () => {
  test("finds exact session first, then numeric-prefix oracle session", () => {
    expect(findWakeSnapshotSession(snapshot, "mawjs", "54-mawjs")?.name).toBe("54-mawjs");
    expect(findWakeSnapshotSession(snapshot, "mawjs", null)?.name).toBe("54-mawjs");
    expect(findWakeSnapshotSession(snapshot, "discord", null)?.name).toBe("discord");
    expect(findWakeSnapshotSession(snapshot, "missing", null)).toBeNull();
  });

  test("plans only missing windows and maps worktree-shaped names to cwd", () => {
    const planned = planSnapshotRestoreWindows(
      "mawjs",
      {
        name: "54-mawjs",
        windows: [
          { name: "mawjs-oracle" },
          { name: "mawjs-feature-a" },
          { name: "mawjs-2-feature-b" },
          { name: "notes" },
          { name: "mawjs-feature-a" },
        ],
      },
      ["mawjs-oracle"],
      [
        { name: "1-feature-a", path: "/repo/mawjs-oracle.wt-1-feature-a" },
        { name: "2-feature-b", path: "/repo/mawjs-oracle.wt-2-feature-b" },
      ],
      "/repo/mawjs-oracle",
    );

    expect(planned).toEqual([
      {
        windowName: "mawjs-feature-a",
        cwd: "/repo/mawjs-oracle.wt-1-feature-a",
        source: "worktree",
      },
      {
        windowName: "mawjs-2-feature-b",
        cwd: "/repo/mawjs-oracle.wt-2-feature-b",
        source: "worktree",
      },
      {
        windowName: "notes",
        cwd: "/repo/mawjs-oracle",
        source: "repo",
      },
    ]);
  });
});
