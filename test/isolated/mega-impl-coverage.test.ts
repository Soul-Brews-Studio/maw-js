/**
 * Isolated coverage for src/vendor/mpr-plugins/mega/impl.ts.
 *
 * impl.ts captures os.homedir() at module load and imports the tmux SDK, so this
 * file runs in the isolated suite with mock.module() seams for both.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "maw-mega-impl-"));
const CLAUDE_DIR = join(TEST_HOME, ".claude");
const TEAMS_DIR = join(CLAUDE_DIR, "teams");
const TASKS_DIR = join(CLAUDE_DIR, "tasks");
const NOW = 1_700_000_000_000;

let paneSnapshots: Array<Set<string>> = [];
let listPaneCalls = 0;
let killPaneCalls: string[] = [];

mock.module("os", () => ({
  homedir: () => TEST_HOME,
}));

mock.module("maw-js/sdk", () => ({
  tmux: {
    listPaneIds: async () => {
      listPaneCalls += 1;
      return paneSnapshots.shift() ?? new Set<string>();
    },
    killPane: async (paneId: string) => {
      killPaneCalls.push(paneId);
    },
  },
}));

const { cmdMegaStatus, cmdMegaStop } = await import("../../src/vendor/mpr-plugins/mega/impl");

const original = {
  log: console.log,
  dateNow: Date.now,
};

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function makeTeam(name: string, config: Record<string, unknown>) {
  writeJson(join(TEAMS_DIR, name, "config.json"), {
    name,
    description: "",
    members: [],
    ...config,
  });
}

function makeTask(teamName: string, fileName: string, task: Record<string, unknown>) {
  writeJson(join(TASKS_DIR, teamName, fileName), task);
}

async function captureLogs(action: () => void | Promise<void>) {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await action();
  } finally {
    console.log = original.log;
  }
  return logs.join("\n");
}

beforeEach(() => {
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
  paneSnapshots = [];
  listPaneCalls = 0;
  killPaneCalls = [];
  Date.now = () => NOW;
});

afterEach(() => {
  console.log = original.log;
  Date.now = original.dateNow;
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("cmdMegaStatus", () => {
  test("prints the empty-state message when the teams directory is absent", async () => {
    const output = stripAnsi(await captureLogs(() => cmdMegaStatus()));

    expect(listPaneCalls).toBe(1);
    expect(output).toContain("No teams found. Use /mega-agent or TeamCreate to start.");
  });

  test("renders live and stale team hierarchy, task summary, model labels, colors, and backend hints", async () => {
    makeTeam("mega-alpha", {
      description: "alpha coverage squad",
      createdAt: NOW - 60 * 60 * 1000,
      members: [
        { name: "captain", agentType: "team-lead", model: "claude-3-opus-20240229", tmuxPaneId: "%lead" },
        { name: "scout", color: "pink", model: "claude-sonnet-4", tmuxPaneId: "%live", backendType: "in-process" },
        { name: "builder", color: "orange", model: "claude-haiku-3", tmuxPaneId: "%dead" },
        { name: "local", model: "inherit", tmuxPaneId: "in-process", backendType: "codex" },
        { name: "mystery", color: "chartreuse" },
      ],
    });
    makeTeam("mega-old", {
      createdAt: NOW - 3 * 60 * 60 * 1000,
      members: [
        { name: "team-lead", model: "custom-llm", tmuxPaneId: "%gone" },
      ],
    });
    makeTask("mega-alpha", "001.json", { id: "1", subject: "ship the thing", status: "completed", owner: "scout" });
    makeTask("mega-alpha", "002.json", { id: "2", subject: "debug flakes", status: "in_progress", owner: "builder" });
    makeTask("mega-alpha", "003.json", { id: "3", subject: "write notes", status: "todo" });
    writeFileSync(join(TASKS_DIR, "mega-alpha", "bad.json"), "not json");
    writeFileSync(join(TASKS_DIR, "mega-alpha", "ignored.txt"), "not a task");
    paneSnapshots = [new Set(["%live"])];

    const raw = await captureLogs(() => cmdMegaStatus());
    const output = stripAnsi(raw);

    expect(listPaneCalls).toBe(1);
    expect(output).toContain("● MEGA-ALPHA");
    expect(output).toContain("alpha coverage squad");
    expect(output).toContain("1/3 tasks");
    expect(output).toContain("team-lead (opus)");
    expect(output).toContain("scout (sonnet) [in-proc]");
    expect(output).toContain("builder (haiku)");
    expect(output).toContain("local (inherit) [codex]");
    expect(output).toContain("mystery (?)");
    expect(output).toContain("✅ ship the thing @scout");
    expect(output).toContain("🔄 debug flakes @builder");
    expect(output).toContain("⬜ write notes");
    expect(output).toContain("○ MEGA-OLD (stale)");
    expect(output).toContain("team-lead (llm)");
    expect(output).toContain("1 alive · 1 stale · 6 agents total");

    expect(raw).toContain("\x1b[38;5;205mscout\x1b[0m");
    expect(raw).toContain("\x1b[38;5;208m●\x1b[0m \x1b[38;5;208mbuilder\x1b[0m");
    expect(raw).toContain("\x1b[90mmystery\x1b[0m");
  });

  test("skips malformed team configs without throwing", async () => {
    mkdirSync(join(TEAMS_DIR, "broken"), { recursive: true });
    writeFileSync(join(TEAMS_DIR, "broken", "config.json"), "not json");

    const output = stripAnsi(await captureLogs(() => cmdMegaStatus()));

    expect(output).toContain("0 alive · 1 stale · 0 agents total");
  });
});

describe("cmdMegaStop", () => {
  test("reports no active teams when only stale or malformed configs exist", async () => {
    makeTeam("mega-old", {
      createdAt: NOW - 3 * 60 * 60 * 1000,
      members: [{ name: "team-lead", tmuxPaneId: "%old" }],
    });
    mkdirSync(join(TEAMS_DIR, "broken"), { recursive: true });
    writeFileSync(join(TEAMS_DIR, "broken", "config.json"), "not json");

    const output = stripAnsi(await captureLogs(() => cmdMegaStop()));

    expect(output).toContain("No active teams to stop.");
    expect(listPaneCalls).toBe(0);
    expect(killPaneCalls).toEqual([]);
  });

  test("kills only live non-empty tmux panes for active teams", async () => {
    makeTeam("mega-active", {
      createdAt: NOW - 5 * 60 * 1000,
      members: [
        { name: "team-lead", tmuxPaneId: "%lead" },
        { name: "scout", tmuxPaneId: "%live" },
        { name: "builder", tmuxPaneId: "%missing" },
        { name: "local", tmuxPaneId: "in-process" },
        { name: "blank", tmuxPaneId: "" },
      ],
    });
    makeTeam("mega-stale", {
      createdAt: NOW - 3 * 60 * 60 * 1000,
      members: [{ name: "stale", tmuxPaneId: "%stale" }],
    });
    paneSnapshots = [new Set(["%live", "%lead"])];

    const output = stripAnsi(await captureLogs(() => cmdMegaStop()));

    expect(output).toContain("⚠  Stopping 1 team(s)...");
    expect(output).toContain("■ mega-active (5 members)");
    expect(output).toContain("killed pane %lead (team-lead)");
    expect(output).toContain("killed pane %live (scout)");
    expect(output).toContain("✓ Panes killed. Run maw mega status to verify.");
    expect(listPaneCalls).toBe(1);
    expect(killPaneCalls).toEqual(["%lead", "%live"]);
    expect(killPaneCalls).not.toContain("%missing");
    expect(killPaneCalls).not.toContain("%stale");
    expect(existsSync(join(TEAMS_DIR, "mega-active", "config.json"))).toBe(true);
  });
});
