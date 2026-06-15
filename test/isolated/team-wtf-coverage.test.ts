import { describe, expect, test } from "bun:test";
import {
  detectTeamNameFromSession,
  inspectTeamWtf,
  parsePs,
  sampleProcessMap,
  type ProcessRow,
} from "../../src/vendor/mpr-plugins/team/team-wtf";
import type { TeamCharter } from "../../src/vendor/mpr-plugins/team/team-charter";
import type { TeamPaneSnapshot } from "../../src/vendor/mpr-plugins/team/team-liveness";
import type { MawConfig } from "../../src/config/types";

const config = {
  host: "local",
  port: 3456,
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: {},
  sessions: {},
  node: "m5",
  engines: {
    codex: { name: "codex", cmd: "codex", processNames: ["codex"] },
    claude: { name: "claude", cmd: "claude", processNames: ["claude"] },
  },
} as MawConfig;

function charter(overrides: Partial<TeamCharter> = {}): TeamCharter {
  return {
    name: "web-v2",
    session: "167-web-v2",
    project: "Soul-Brews-Studio/web-v2",
    members: [
      { role: "coder-1", engine: "codex" },
    ],
    ...overrides,
  };
}

function pane(overrides: Partial<TeamPaneSnapshot> = {}): TeamPaneSnapshot {
  return {
    sessionName: "167-web-v2",
    windowName: "web-v2-coder-1",
    command: "codex",
    path: "/repo/agents/1-coder-1",
    paneId: "%1",
    panePid: "100",
    sessionId: "$167",
    windowId: "@1",
    ...overrides,
  };
}

function deps(opts: {
  charter?: TeamCharter;
  panes?: TeamPaneSnapshot[];
  psSamples?: ProcessRow[][];
  session?: string;
} = {}) {
  let idx = 0;
  const samples = opts.psSamples ?? [[{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }]];
  return {
    currentTmuxSessionFn: async () => opts.session ?? "167-web-v2",
    currentWindowRefFn: async () => undefined,
    resolveCharterPathFn: (team: string) => team === "web-v2" ? "/repo/.maw/teams/web-v2.yaml" : null,
    readTeamCharterFn: () => opts.charter ?? charter(),
    listPaneSnapshotsFn: async () => opts.panes ?? [pane()],
    loadConfigFn: () => config,
    ps: () => samples[Math.min(idx++, samples.length - 1)]!,
  };
}

function byName(result: Awaited<ReturnType<typeof inspectTeamWtf>>, name: string) {
  const check = result.checks.find((item) => item.name === name);
  expect(check).toBeTruthy();
  return check!;
}

describe("maw wtf read-only diagnose (#2805)", () => {
  test("detects team name from numbered tmux session", () => {
    expect(detectTeamNameFromSession("167-web-v2")).toBe("web-v2");
    expect(detectTeamNameFromSession("web-v2")).toBe("web-v2");
  });

  test("processMap binds only descendants of pane_pid", async () => {
    const sample = await sampleProcessMap([pane()], ["codex"], {
      ps: () => parsePs(`
        100 1 100 zsh
        101 100 100 bash
        102 101 100 /usr/bin/codex --yolo
        200 1 200 codex unrelated
      `),
    });
    const binding = sample.byPaneId.get("%1");
    expect(binding?.processes.map((row) => row.pid)).toEqual([101, 102]);
    expect(binding?.engineProcesses.map((row) => row.pid)).toEqual([102]);
  });

  test("auto-detects current team and reports healthy aligned BUSY member after double sample", async () => {
    const result = await inspectTeamWtf(undefined, { cwd: "/repo" }, deps({
      psSamples: [
        [{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }],
        [{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }],
      ],
    }));
    expect(result.ok).toBe(true);
    expect(result.team).toBe("web-v2");
    const check = byName(result, "team:coder-1:state");
    expect(check.ok).toBe(true);
    expect(check.message).toContain("aligned");
    expect(check.fix).toEqual([]);
  });

  test("two negative process samples diagnose a dead-frame and recommend done", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo" }, deps({
      psSamples: [
        [{ pid: 101, ppid: 100, pgid: 100, args: "bash" }],
        [{ pid: 101, ppid: 100, pgid: 100, args: "bash" }],
      ],
    }));
    const check = byName(result, "team:coder-1:dead-frame");
    expect(result.ok).toBe(false);
    expect(check.severity).toBe("error");
    expect(check.fix).toContain("maw done coder-1");
  });

  test("one negative process sample remains UNKNOWN, never safe/dead", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo", processSampleCount: 1 }, deps({
      psSamples: [[{ pid: 101, ppid: 100, pgid: 100, args: "bash" }]],
    }));
    const check = byName(result, "team:coder-1:unknown-busy");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.fix).toEqual([]);
  });

  test("current lead window suppresses destructive dead-frame fix", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo" }, {
      ...deps({
        psSamples: [
          [{ pid: 101, ppid: 100, pgid: 100, args: "bash" }],
          [{ pid: 101, ppid: 100, pgid: 100, args: "bash" }],
        ],
      }),
      currentWindowRefFn: async () => "$167:@1",
    });
    const check = byName(result, "team:coder-1:dead-frame");
    expect(check.message).toContain("lead protected");
    expect(check.fix).toEqual([]);
  });

  test("missing member recommends exact team up --only role", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo" }, deps({ panes: [] }));
    const check = byName(result, "team:coder-1:state");
    expect(check.ok).toBe(false);
    expect(check.fix).toEqual(["maw team up web-v2 --only coder-1"]);
  });

  test("off-node member is report-only and never recommends teardown", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo" }, deps({
      charter: charter({ members: [{ role: "oss-coder", engine: "codex", node: "oss" }] }),
      panes: [],
    }));
    const check = byName(result, "team:oss-coder:off-node");
    expect(check.ok).toBe(true);
    expect(check.fix).toEqual([]);
    expect(check.message).toContain("report only");
  });

  test("stuck prompt recommends send-text/send-enter to exact pane", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo" }, deps({
      panes: [pane({ path: "Do you trust the contents of this directory? Yes, continue", paneId: "%42" })],
      psSamples: [
        [{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }],
        [{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }],
      ],
    }));
    const check = byName(result, "team:coder-1:blocked-prompt");
    expect(check.severity).toBe("warn");
    expect(check.fix).toEqual(["maw send-text %42 y", "maw send-enter %42"]);
  });

  test("orphan team-looking pane recommends exact maw kill target", async () => {
    const result = await inspectTeamWtf("web-v2", { cwd: "/repo" }, deps({
      panes: [pane(), pane({ windowName: "web-v2-extra", paneId: "%9", panePid: "900" })],
      psSamples: [
        [{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }],
        [{ pid: 101, ppid: 100, pgid: 100, args: "codex --yolo" }],
      ],
    }));
    const check = byName(result, "team:orphan:web-v2-extra");
    expect(check.ok).toBe(false);
    expect(check.fix).toEqual(["maw kill 167-web-v2:web-v2-extra"]);
  });
});
