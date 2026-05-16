import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildWakeBudLineage,
  findWakeSnapshotSession,
  getLiveTileRoles,
  planRehydrateWorktreeWindows,
  planSnapshotRestoreWindows,
  retryFreshSessionTmuxStep,
  shouldOfferExistingSessionAttach,
  waitForTmuxSessionReady,
  writeWakeBudBirthSignal,
  writeWakeBudLineage,
} from "../src/commands/shared/wake-cmd";
import type { Snapshot } from "../src/core/fleet/snapshot";

const tempRoots: string[] = [];
const originalClaudeAgentName = process.env.CLAUDE_AGENT_NAME;
const originalMawOracleName = process.env.MAW_ORACLE_NAME;

function restoreEnv(name: "CLAUDE_AGENT_NAME" | "MAW_ORACLE_NAME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreEnv("CLAUDE_AGENT_NAME", originalClaudeAgentName);
  restoreEnv("MAW_ORACLE_NAME", originalMawOracleName);
});

describe("wake-bud lineage helpers — default coverage", () => {
  it("builds stable YAML scalar lineage when all fields are explicit", () => {
    const lineage = buildWakeBudLineage({
      parentOracle: "mawjs",
      task: "issue-1637",
      branch: "test/coverage",
      buddedAt: "2026-05-16T20:00:00.000Z",
      buddedBy: "codex",
    });

    expect(lineage).toBe([
      'budded_from: "mawjs"',
      'budded_at: "2026-05-16T20:00:00.000Z"',
      'budded_by: "codex"',
      'branch: "test/coverage"',
      'task: "issue-1637"',
      "",
    ].join("\n"));
  });

  it("uses the runtime actor fallback and blank branch defaults", () => {
    process.env.CLAUDE_AGENT_NAME = "mawjs-codex";
    const lineage = buildWakeBudLineage({
      parentOracle: "mawjs",
      task: "cover wake",
      buddedAt: "2026-05-16T20:01:00.000Z",
    });

    expect(lineage).toContain('budded_by: "mawjs-codex"');
    expect(lineage).toContain('branch: ""');
  });

  it("writes lineage under ψ/.lineage.yaml", () => {
    const root = tempRoot("maw-wake-lineage-");
    const file = writeWakeBudLineage(root, {
      parentOracle: "mawjs",
      task: "issue-1637",
      branch: "alpha",
      buddedAt: "2026-05-16T20:02:00.000Z",
      buddedBy: "codex",
    });

    expect(file).toBe(join(root, "ψ", ".lineage.yaml"));
    expect(readFileSync(file, "utf8")).toContain('task: "issue-1637"');
  });

  it("writes a wake-bud birth signal with worktree context", () => {
    const parent = tempRoot("maw-wake-signal-");
    const file = writeWakeBudBirthSignal(parent, "mawjs-issue-1637", {
      parentOracle: "mawjs",
      task: "issue-1637",
      branch: "alpha",
      worktreePath: "/repo/mawjs-oracle.wt-issue-1637",
    });

    expect(existsSync(file)).toBe(true);
    const signal = JSON.parse(readFileSync(file, "utf8"));
    expect(signal.kind).toBe("info");
    expect(signal.message).toBe("wake-bud born: mawjs-issue-1637");
    expect(signal.context).toEqual({
      buddedFrom: "mawjs",
      task: "issue-1637",
      branch: "alpha",
      worktreePath: "/repo/mawjs-oracle.wt-issue-1637",
    });
  });
});

describe("wake attach prompt gate — default coverage", () => {
  it("offers attach only for interactive plain wake", () => {
    expect(shouldOfferExistingSessionAttach({}, true)).toBe(true);
    expect(shouldOfferExistingSessionAttach({ attach: true }, true)).toBe(false);
    expect(shouldOfferExistingSessionAttach({ split: true }, true)).toBe(false);
    expect(shouldOfferExistingSessionAttach({ bring: true }, true)).toBe(false);
    expect(shouldOfferExistingSessionAttach({}, false)).toBe(false);
  });
});

describe("wake live tile role reader — default coverage", () => {
  it("returns trimmed non-empty tmux tile roles", async () => {
    const roles = await getLiveTileRoles("54-mawjs", {
      hostExecFn: async cmd => {
        expect(cmd).toBe("tmux list-panes -t '54-mawjs' -F '#{@maw_tile_role}'");
        return "tile-1\n\n tile-2 \n";
      },
    });

    expect([...roles]).toEqual(["tile-1", "tile-2"]);
  });

  it("fails soft to an empty set when tmux role lookup fails", async () => {
    const roles = await getLiveTileRoles("missing", {
      hostExecFn: async () => { throw new Error("can't find session"); },
    });

    expect(roles.size).toBe(0);
  });
});

describe("fresh wake tmux readiness — default coverage", () => {
  it("waits until the fresh session becomes visible", async () => {
    let checks = 0;
    const sleeps: number[] = [];

    await waitForTmuxSessionReady("47-mawjs", {
      attempts: 4,
      delayMs: 5,
      sleep: async ms => { sleeps.push(ms); },
      hasSession: async session => {
        expect(session).toBe("47-mawjs");
        checks++;
        return checks === 3;
      },
    });

    expect(checks).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  it("throws after exhausting visibility checks", async () => {
    const sleeps: number[] = [];
    await expect(waitForTmuxSessionReady("47-mawjs", {
      attempts: 3,
      delayMs: 7,
      sleep: async ms => { sleeps.push(ms); },
      hasSession: async () => false,
    })).rejects.toThrow("tmux did not report fresh session '47-mawjs' ready after 3 checks");
    expect(sleeps).toEqual([7, 7]);
  });

  it("retries transient can't-find-session setup races", async () => {
    let attempts = 0;
    let visibilityChecks = 0;

    const result = await retryFreshSessionTmuxStep("47-mawjs", "launch main window", async () => {
      attempts++;
      if (attempts === 1) throw new Error("[local:local] can't find session: 47-mawjs");
      return "launched";
    }, {
      attempts: 3,
      delayMs: 5,
      sleep: async () => {},
      hasSession: async session => {
        expect(session).toBe("47-mawjs");
        visibilityChecks++;
        return true;
      },
    });

    expect(result).toBe("launched");
    expect(attempts).toBe(2);
    expect(visibilityChecks).toBe(1);
  });

  it("does not hide unrelated setup failures", async () => {
    let attempts = 0;

    await expect(retryFreshSessionTmuxStep("47-mawjs", "set session environment", async () => {
      attempts++;
      throw new Error("pass show 'secret' failed (exit 1)");
    }, {
      attempts: 3,
      sleep: async () => {},
      hasSession: async () => true,
    })).rejects.toThrow(/pass show/);

    expect(attempts).toBe(1);
  });

  it("treats nested causes as fresh-session lookup races until attempts exhaust", async () => {
    let attempts = 0;
    await expect(retryFreshSessionTmuxStep("47-mawjs", "select window", async () => {
      attempts++;
      throw new Error("outer", { cause: new Error("can't find window: 47-mawjs") });
    }, {
      attempts: 2,
      delayMs: 1,
      sleep: async () => {},
      hasSession: async () => true,
    })).rejects.toThrow("outer");
    expect(attempts).toBe(2);
  });
});

describe("wake worktree rehydrate planning — default coverage", () => {
  it("plans missing worktree windows, skips live tile roles, and avoids duplicate window names", () => {
    const planned = planRehydrateWorktreeWindows(
      "mawjs",
      [
        { name: "1-feature-a", path: "/repo/mawjs-oracle.wt-1-feature-a" },
        { name: "2-tile-1", path: "/repo/mawjs-oracle.wt-2-tile-1" },
        { name: "feature-a", path: "/repo/mawjs-oracle.wt-feature-a" },
        { name: "3-feature-c", path: "/repo/mawjs-oracle.wt-3-feature-c" },
      ],
      ["mawjs-oracle", "mawjs-feature-a"],
      new Set(["tile-1"]),
    );

    expect(planned).toEqual([
      {
        worktreeName: "3-feature-c",
        windowName: "mawjs-feature-c",
        path: "/repo/mawjs-oracle.wt-3-feature-c",
      },
    ]);
  });

  it("falls back to numeric worktree names when the stripped name is already planned", () => {
    const planned = planRehydrateWorktreeWindows("mawjs", [
      { name: "feature-a", path: "/repo/wt-feature-a" },
      { name: "2-feature-a", path: "/repo/wt-2-feature-a" },
    ]);

    expect(planned).toEqual([
      { worktreeName: "feature-a", windowName: "mawjs-feature-a", path: "/repo/wt-feature-a" },
      { worktreeName: "2-feature-a", windowName: "mawjs-2-feature-a", path: "/repo/wt-2-feature-a" },
    ]);
  });
});

describe("wake snapshot restore planning — default coverage", () => {
  const snapshot: Snapshot = {
    timestamp: "2026-05-16T11:00:00.000Z",
    trigger: "wake",
    node: "m5",
    sessions: [
      { name: "54-mawjs", windows: [{ name: "mawjs-oracle" }, { name: "mawjs-feature-a" }] },
      { name: "discord", windows: [{ name: "discord-oracle" }] },
    ],
  };

  it("finds exact sessions before numeric-prefix and suffix oracle matches", () => {
    expect(findWakeSnapshotSession(snapshot, "mawjs", "54-mawjs")?.name).toBe("54-mawjs");
    expect(findWakeSnapshotSession(snapshot, "mawjs", null)?.name).toBe("54-mawjs");
    expect(findWakeSnapshotSession(snapshot, "discord", null)?.name).toBe("discord");
    expect(findWakeSnapshotSession(snapshot, "missing", null)).toBeNull();
  });

  it("plans only missing snapshot windows and maps worktree-shaped names to cwd", () => {
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
          { name: "   " },
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
