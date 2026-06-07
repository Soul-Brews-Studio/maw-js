import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const srcRoot = join(import.meta.dir, "../..");

let signals: Array<{ root: string; child: string; signal: any }> = [];

mock.module(join(srcRoot, "src/core/fleet/leaf"), () => ({
  writeSignal: (root: string, child: string, signal: any) => {
    signals.push({ root, child, signal });
    return join(root, "ψ", "memory", "signals", `${child}.json`);
  },
}));

const {
  buildWakeBudLineage,
  findWakeSnapshotSession,
  planRehydrateWorktreeWindows,
  planSnapshotRestoreWindows,
  retryFreshSessionTmuxStep,
  shouldOfferExistingSessionAttach,
  waitForTmuxSessionReady,
  writeWakeBudBirthSignal,
  writeWakeBudLineage,
} = await import("../../src/commands/shared/wake-cmd-helpers");

let tempRoot = "";
const originalEnv = { ...process.env };

type SnapshotSession = Parameters<typeof findWakeSnapshotSession>[0]["sessions"][number];

beforeEach(() => {
  signals = [];
  tempRoot = mkdtempSync(join(tmpdir(), "maw-wake-cmd-helper-"));
  process.env.CLAUDE_AGENT_NAME = "tester-oracle";
  delete process.env.MAW_TEST_MODE;

});

afterEach(() => {
  process.env = { ...originalEnv };
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });

});

describe("wake-cmd helper coverage", () => {
  test("writes deterministic wake-bud lineage and birth signal payloads", () => {
    const lineage = buildWakeBudLineage({
      parentOracle: "parent",
      task: "fix quotes",
      branch: "feat/a'b",
      buddedAt: "2026-05-18T00:00:00.000Z",
    });

    expect(lineage).toBe([
      'budded_from: "parent"',
      'budded_at: "2026-05-18T00:00:00.000Z"',
      'budded_by: "tester-oracle"',
      'branch: "feat/a\'b"',
      'task: "fix quotes"',
      "",
    ].join("\n"));

    const lineageFile = writeWakeBudLineage(tempRoot, {
      parentOracle: "parent",
      task: "fix quotes",
      branch: "feat/a'b",
      buddedAt: "2026-05-18T00:00:00.000Z",
      buddedBy: "explicit-actor",
    });
    expect(lineageFile).toBe(join(tempRoot, "ψ", ".lineage.yaml"));
    expect(readFileSync(lineageFile, "utf8")).toContain('budded_by: "explicit-actor"');

    const signalFile = writeWakeBudBirthSignal(tempRoot, "parent-fix", {
      parentOracle: "parent",
      task: "fix quotes",
      branch: "feat/a'b",
      worktreePath: join(tempRoot, "parent.wt-fix"),
    });
    expect(signalFile).toBe(join(tempRoot, "ψ", "memory", "signals", "parent-fix.json"));
    expect(signals).toEqual([
      {
        root: tempRoot,
        child: "parent-fix",
        signal: {
          kind: "info",
          message: "wake-bud born: parent-fix",
          context: {
            buddedFrom: "parent",
            task: "fix quotes",
            branch: "feat/a'b",
            worktreePath: join(tempRoot, "parent.wt-fix"),
          },
        },
      },
    ]);
  });

  test("shouldOfferExistingSessionAttach only offers for plain interactive wakes outside test mode", () => {
    expect(shouldOfferExistingSessionAttach({}, true, {} as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldOfferExistingSessionAttach({ attach: true }, true, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldOfferExistingSessionAttach({ split: true }, true, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldOfferExistingSessionAttach({ bring: true }, true, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldOfferExistingSessionAttach({}, false, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldOfferExistingSessionAttach({}, true, { MAW_TEST_MODE: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("waitForTmuxSessionReady retries, waits between attempts, and throws after exhaustion", async () => {
    const checks: string[] = [];
    const waits: number[] = [];
    let attempt = 0;

    await waitForTmuxSessionReady("77-maw", {
      attempts: 3,
      delayMs: 5,
      hasSession: async (session) => {
        checks.push(session);
        attempt++;
        return attempt === 3;
      },
      sleep: async (ms) => { waits.push(ms); },
    });

    expect(checks).toEqual(["77-maw", "77-maw", "77-maw"]);
    expect(waits).toEqual([5, 5]);

    await expect(waitForTmuxSessionReady("missing", {
      attempts: 2,
      delayMs: 9,
      hasSession: async () => false,
      sleep: async (ms) => { waits.push(ms); },
      throwOnTimeout: true,
    })).rejects.toThrow("tmux did not report fresh session 'missing' ready after 2 checks");
  });

  test("retryFreshSessionTmuxStep retries fresh-session lookup races and preserves other errors", async () => {
    const waits: number[] = [];
    let calls = 0;

    const result = await retryFreshSessionTmuxStep("88-maw", "launch", async () => {
      calls++;
      if (calls === 1) {
        throw new Error("tmux: can't find pane: 88-maw:maw-oracle", { cause: new Error("nested cause") });
      }
      return "ok";
    }, {
      attempts: 3,
      delayMs: 4,
      hasSession: async (session) => session === "88-maw",
      sleep: async (ms) => { waits.push(ms); },
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(waits).toEqual([4]);

    await expect(retryFreshSessionTmuxStep("88-maw", "launch", async () => {
      throw new Error("permission denied");
    }, {
      attempts: 2,
      sleep: async () => {},
    })).rejects.toThrow("permission denied");
  });

  test("retryFreshSessionTmuxStep handles non-Error lookup races and unreachable exhausted loops", async () => {
    const waits: number[] = [];
    let calls = 0;

    const result = await retryFreshSessionTmuxStep("88-maw", "launch", async () => {
      calls++;
      if (calls === 1) throw "tmux: can't find session: 88-maw";
      return "ok";
    }, {
      attempts: 2,
      delayMs: 7,
      sleep: async (ms) => { waits.push(ms); },
    });

    expect(result).toBe("ok");
    expect(waits).toEqual([7]);

    await expect(retryFreshSessionTmuxStep("88-maw", "launch", async () => "never", {
      attempts: 0,
      sleep: async () => {},
    })).rejects.toThrow("unreachable: fresh tmux session setup step 'launch' exhausted without throwing");
  });

  test("plans rehydrate windows while avoiding live tile roles, existing canonical names, and duplicate collisions", () => {
    const planned = planRehydrateWorktreeWindows("maw", [
      { name: "1-alpha", path: "/repo.wt-1-alpha" },
      { name: "2-beta", path: "/repo.wt-2-beta" },
      { name: "3-gamma", path: "/repo.wt-3-gamma" },
      { name: "4-gamma", path: "/repo.wt-4-gamma" },
      { name: "5-delta", path: "/repo.wt-5-delta" },
    ], ["maw-alpha", "maw-3-gamma"], new Set(["beta"]));

    expect(planned).toEqual([
      { worktreeName: "4-gamma", windowName: "maw-gamma", path: "/repo.wt-4-gamma" },
      { worktreeName: "5-delta", windowName: "maw-delta", path: "/repo.wt-5-delta" },
    ]);
  });

  test("findWakeSnapshotSession prefers exact requested sessions then fleet-prefix-insensitive oracle matches", () => {
    const sessions: SnapshotSession[] = [
      { name: "notes", windows: [] },
      { name: "42-maw", windows: [] },
      { name: "77-volt", windows: [] },
    ];
    const snapshot = { timestamp: "2026-05-18T00:00:00.000Z", sessions } as Parameters<typeof findWakeSnapshotSession>[0];

    expect(findWakeSnapshotSession(snapshot, "maw", "notes")?.name).toBe("notes");
    expect(findWakeSnapshotSession(snapshot, "01-maw")?.name).toBe("42-maw");
    expect(findWakeSnapshotSession(snapshot, "volt")?.name).toBe("77-volt");
    expect(findWakeSnapshotSession(snapshot, "missing")).toBeNull();
  });

  test("plans snapshot restore windows using repo fallback, worktree cwd matches, duplicate skips, and existing skips", () => {
    const plan = planSnapshotRestoreWindows("maw", {
      name: "54-maw",
      windows: [
        { name: "" },
        { name: "main" },
        { name: "main" },
        { name: "already" },
        { name: "maw-alpha" },
        { name: "maw-2-beta" },
        { name: "maw-gamma" },
      ],
    } as SnapshotSession, new Set(["already"]), [
      { name: "1-alpha", path: "/repo.wt-1-alpha" },
      { name: "2-beta", path: "/repo.wt-2-beta" },
    ], "/repo/main");

    expect(plan).toEqual([
      { windowName: "main", cwd: "/repo/main", source: "repo" },
      { windowName: "maw-alpha", cwd: "/repo.wt-1-alpha", source: "worktree" },
      { windowName: "maw-2-beta", cwd: "/repo.wt-2-beta", source: "worktree" },
      { windowName: "maw-gamma", cwd: "/repo/main", source: "repo" },
    ]);
  });

  test("fresh-session helpers cover default best-effort wait dependencies", async () => {
    await waitForTmuxSessionReady("never-visible", { attempts: 2, delayMs: 1 });

    let calls = 0;
    const result = await retryFreshSessionTmuxStep("89-maw", "attach", async () => {
      calls++;
      if (calls === 1) throw new Error("tmux: can't find session: 89-maw");
      return "ready";
    }, { attempts: 2, delayMs: 1 });

    expect(result).toBe("ready");
  });

});
