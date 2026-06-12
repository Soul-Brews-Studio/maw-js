/**
 * team-wtf-fix-deny-gates.test.ts — #2806 prep scaffold.
 *
 * #2805 provides the read-only `maw wtf` diagnose surface. Its stable contract
 * is DoctorCheck[] with string `fix` verbs; `details` may carry advisory machine
 * hints but is not a stable action API. These tests pin #2806's safety contract:
 * `--fix` is an allowlisted exact-ID transaction runner, never a name-based
 * destructive command loop.
 */
import { describe, expect, test } from "bun:test";
import type { DoctorCheck } from "../../src/vendor/mpr-plugins/doctor/impl";
import { cmdTeamWtfFix, planWtfFixTransactions } from "../../src/vendor/mpr-plugins/team/team-wtf-fix";

type ProtectedIds = {
  currentSessionId: string;
  currentWindowId: string;
  currentPaneId: string;
  leadWindowIds: string[];
};

type FixtureContext = {
  team: string;
  sessionName: string;
  sessionId: string;
  protected: ProtectedIds;
};

type FixPlanInput = {
  checks: DoctorCheck[];
  context: FixtureContext;
  confirm?: string;
};

type FixPlanResult = {
  transactions?: unknown[];
  denied?: Array<{ reason?: string; message?: string; command?: string }>;
  commands?: string[];
};

function planner() {
  return planWtfFixTransactions;
}

const baseContext: FixtureContext = {
  team: "alpha",
  sessionName: "167-alpha",
  sessionId: "$lead-session",
  protected: {
    currentSessionId: "$lead-session",
    currentWindowId: "@lead-window",
    currentPaneId: "%lead-pane",
    leadWindowIds: ["@lead-window", "@charter-lead"],
  },
};

function check(name: string, fix: string[], details: unknown = {}): DoctorCheck {
  return { name, ok: false, severity: "error", message: name, fix, details };
}

function denialText(result: FixPlanResult): string {
  return JSON.stringify(result.denied ?? result, null, 2).toLowerCase();
}

function plannedCommands(result: FixPlanResult): string[] {
  return result.commands ?? result.transactions?.map((tx) => JSON.stringify(tx)) ?? [];
}

describe("maw wtf --fix deny gates (#2806)", () => {
  test("denies any team down --all codepath even when a diagnosis suggests it", async () => {
    const result = await planner()({
      context: baseContext,
      checks: [check("team:dangerous-fix", ["maw team down alpha --all"])],
    });

    expect(plannedCommands(result).join("\n")).not.toContain("team down");
    expect(denialText(result)).toContain("down --all");
  });

  test("denies killing the current session by exact tmux session id", async () => {
    const result = await planner()({
      context: baseContext,
      checks: [check("team:zombie-session", ["tmux kill-session -t 167-alpha"], {
        target: { sessionName: "167-alpha", sessionId: "$lead-session" },
      })],
    });

    expect(plannedCommands(result).join("\n")).not.toContain("kill-session");
    expect(denialText(result)).toMatch(/current|protected|lead/);
  });

  test("denies killing any charter lead window even when the member name collides", async () => {
    const result = await planner()({
      context: baseContext,
      checks: [check("team:orphan-window", ["maw kill alpha:coder-1"], {
        role: "coder-1",
        target: { sessionId: "$lead-session", windowId: "@charter-lead", windowName: "coder-1" },
      })],
    });

    expect(plannedCommands(result).join("\n")).not.toContain("maw kill");
    expect(denialText(result)).toMatch(/lead|protected/);
  });

  test("denies ambiguous duplicate-name and normalized-collision window targets", async () => {
    const result = await planner()({
      context: baseContext,
      checks: [check("team:ambiguous-window", ["maw done wt-coder-2"], {
        target: { windowName: "wt-coder-2" },
        matches: [
          { sessionId: "$lead-session", windowId: "@one", windowName: "web-v2.wt-coder-2" },
          { sessionId: "$lead-session", windowId: "@two", windowName: "web-v2-wt-coder-2" },
        ],
      })],
    });

    expect(plannedCommands(result).join("\n")).not.toContain("maw done");
    expect(denialText(result)).toMatch(/ambiguous|collision|duplicate/);
  });

  test("requires verified non-empty WIP archive before teardown", async () => {
    const result = await planner()({
      context: baseContext,
      checks: [check("team:dead-frame", ["maw done wt-coder-3"], {
        target: { sessionId: "$lead-session", windowId: "@dead", worktree: "agents/1-wt-coder-3" },
        wipArchive: { path: "ψ/inbox/rescued-wip/empty.patch", bytes: 0, verifiedApplicable: false },
      })],
    });

    expect(plannedCommands(result).join("\n")).not.toContain("maw done");
    expect(denialText(result)).toMatch(/wip|archive|non-empty|applicable/);
  });

  test("orphan-pid fixes require strong confirm and prefer SIGTERM before any escalation", async () => {
    const withoutConfirm = await planner()({
      context: baseContext,
      checks: [check("team:orphan-pid", ["kill 4242"], {
        target: { pid: 4242, startTime: 1718251200, argv: "omx --yolo", cwd: "/tmp/wt" },
      })],
    });

    expect(plannedCommands(withoutConfirm).join("\n")).not.toContain("kill 4242");
    expect(denialText(withoutConfirm)).toMatch(/strong|confirm|manual/);

    const withConfirm = await planner()({
      context: baseContext,
      confirm: "I understand this kills orphan pid 4242 with SIGTERM first",
      checks: [check("team:orphan-pid", ["kill 4242"], {
        target: { pid: 4242, startTime: 1718251200, argv: "omx --yolo", cwd: "/tmp/wt" },
      })],
    });

    const commands = plannedCommands(withConfirm).join("\n");
    expect(commands).toContain("SIGTERM");
    expect(commands).not.toContain("SIGKILL");
  });


  test("cmdTeamWtfFix is plan-only without explicit confirm", async () => {
    const executed: string[] = [];
    const result = await cmdTeamWtfFix("alpha", { dryRun: false }, {
      inspectTeamWtfFn: async () => ({
        ok: false,
        team: "alpha",
        session: "167-alpha",
        charterPath: "/repo/.maw/teams/alpha.yaml",
        checks: [
          {
            name: "team:context",
            ok: true,
            message: "context",
            details: { leadWindowRef: "$lead-session:@lead-window" },
            fix: [],
          },
          check("team:missing", ["maw team up alpha --only coder-1"]),
        ],
      }),
      exec: async (command: string) => { executed.push(command); return ""; },
    });

    expect(result.commands).toContain("maw team up alpha --only coder-1");
    expect(executed).toEqual([]);
  });

  test("plan-only mode does not archive WIP as a side effect", async () => {
    let archived = false;
    await cmdTeamWtfFix("alpha", { dryRun: false }, {
      inspectTeamWtfFn: async () => ({
        ok: false,
        team: "alpha",
        session: "167-alpha",
        charterPath: "/repo/.maw/teams/alpha.yaml",
        checks: [
          {
            name: "team:context",
            ok: true,
            message: "context",
            details: { leadWindowRef: "$lead-session:@lead-window" },
            fix: [],
          },
          check("team:dead-frame", ["maw done wt-coder-3"]),
        ],
      }),
      archiveWipFn: () => { archived = true; return { path: "x.patch", bytes: 1, verifiedApplicable: true }; },
      exec: async () => "",
    });

    expect(archived).toBe(false);
  });

  test("execution re-runs diagnosis immediately after each transaction", async () => {
    const calls: string[] = [];
    await cmdTeamWtfFix("alpha", { dryRun: false, confirm: "confirm" }, {
      inspectTeamWtfFn: async () => {
        calls.push("inspect");
        return {
          ok: false,
          team: "alpha",
          session: "167-alpha",
          charterPath: "/repo/.maw/teams/alpha.yaml",
          checks: [
            {
              name: "team:context",
              ok: true,
              message: "context",
              details: { leadWindowRef: "$lead-session:@lead-window" },
              fix: [],
            },
            check("team:missing", ["maw team up alpha --only coder-1"]),
            check("team:stuck", ["maw send-enter %2"]),
          ],
        };
      },
      exec: async (command: string) => { calls.push(command); return ""; },
    });

    expect(calls).toEqual([
      "inspect",
      "maw team up alpha --only coder-1",
      "inspect",
      "maw send-enter %2",
      "inspect",
    ]);
  });

  test("plans a fresh diagnosis re-run after every applied transaction", async () => {
    const result = await planner()({
      context: baseContext,
      checks: [check("team:orphan-window", ["maw kill 167-alpha:stale"], {
        target: { sessionId: "$lead-session", windowId: "@stale", windowName: "stale" },
        lifecycleOwned: false,
      })],
    });

    expect(JSON.stringify(result).toLowerCase()).toMatch(/diagnos|re-?run|verify/);
  });
});
