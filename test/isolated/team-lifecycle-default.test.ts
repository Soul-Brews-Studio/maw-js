import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const rootSrc = join(import.meta.dir, "../../src");
const layoutCalls: unknown[] = [];
const snapshotCalls: unknown[] = [];
const sendShutdownCalls: unknown[] = [];
let cleanupReturn = 0;
let spawnResult = { paneId: "%spawned", color: "blue" };
let spawnTeammatePaneImpl = async (...args: unknown[]) => {
  layoutCalls.push(["spawnTeammatePane", ...args]);
  return spawnResult;
};
let sendShutdownImpl = (...args: unknown[]) => {
  sendShutdownCalls.push(args);
  Date.now();
  return "/tmp/shutdown.json";
};
const tmuxMock = {
  listPaneIds: async () => paneSnapshots.shift() ?? new Set<string>(),
  killPane: async (paneId: string) => { killPaneCalls.push(paneId); },
};

mock.module(join(rootSrc, "sdk/index.ts"), () => ({ tmux: tmuxMock }));
mock.module(join(rootSrc, "sdk/index"), () => ({ tmux: tmuxMock }));
mock.module(join(rootSrc, "sdk"), () => ({ tmux: tmuxMock }));
mock.module("../../src/sdk/index", () => ({ tmux: tmuxMock }));
mock.module("../../src/sdk", () => ({ tmux: tmuxMock }));

mock.module(join(rootSrc, "commands/plugins/tmux/layout-manager"), () => ({
  cleanupTeamPanes: async (...args: unknown[]) => {
    layoutCalls.push(["cleanupTeamPanes", ...args]);
    return cleanupReturn;
  },
  spawnTeammatePane: async (...args: unknown[]) => spawnTeammatePaneImpl(...args),
  colorAnsi: (color: string) => color === "green" ? "32" : "34",
}));

mock.module(join(rootSrc, "commands/plugins/team/layout-snapshot"), () => ({
  saveLayoutSnapshot: (...args: unknown[]) => {
    snapshotCalls.push(args);
  },
}));

mock.module(join(rootSrc, "commands/plugins/team/inbox"), () => ({
  sendShutdown: (...args: unknown[]) => sendShutdownImpl(...args),
}));

const helpers = await import("../../src/commands/plugins/team/team-helpers");
const lifecycle = await import("../../src/commands/plugins/team/team-lifecycle");

const original = {
  cwd: process.cwd(),
  log: console.log,
  error: console.error,
  tmux: process.env.TMUX,
  tmuxPane: process.env.TMUX_PANE,
  setTimeout: globalThis.setTimeout,
  dateNow: Date.now,
};

let root = "";
let teamsDir = "";
let tasksDir = "";
let logs: string[] = [];
let errors: string[] = [];
let paneSnapshots: Array<Set<string>> = [];
let killPaneCalls: string[] = [];

function json(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function makeOracleRoot() {
  root = mkdtempSync(join(tmpdir(), "maw-team-lifecycle-"));
  mkdirSync(join(root, "ψ"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "test oracle\n");
  teamsDir = join(root, "tool-teams");
  tasksDir = join(root, "tool-tasks");
  helpers._setDirs(teamsDir, tasksDir);
  process.chdir(root);
}

function makeToolTeam(name: string, members: any[]) {
  const dir = join(teamsDir, name);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "config.json"), { name, description: "", members, createdAt: 1 });
  return dir;
}

beforeEach(() => {
  makeOracleRoot();
  logs = [];
  errors = [];
  layoutCalls.length = 0;
  snapshotCalls.length = 0;
  sendShutdownCalls.length = 0;
  cleanupReturn = 0;
  spawnResult = { paneId: "%spawned", color: "blue" };
  spawnTeammatePaneImpl = async (...args: unknown[]) => {
    layoutCalls.push(["spawnTeammatePane", ...args]);
    return spawnResult;
  };
  sendShutdownImpl = (...args: unknown[]) => {
    sendShutdownCalls.push(args);
    Date.now();
    return "/tmp/shutdown.json";
  };
  paneSnapshots = [];
  killPaneCalls = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  (globalThis as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
    fn(...args);
    return 0 as any;
  };
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
  if (original.tmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = original.tmuxPane;
  globalThis.setTimeout = original.setTimeout;
  Date.now = original.dateNow;
  helpers._setDirs(join(process.env.HOME || original.cwd, ".claude/teams"), join(process.env.HOME || original.cwd, ".claude/tasks"));
  process.chdir(original.cwd);
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("team-lifecycle coverage", () => {
  test("create writes both mailbox manifest and tool-store stub, and rejects duplicates", () => {
    lifecycle.cmdTeamCreate("qa-team", { description: "coverage slice" });

    const mailboxManifest = json(join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json"));
    expect(mailboxManifest).toMatchObject({ name: "qa-team", members: [], description: "coverage slice" });
    const toolConfig = json(join(teamsDir, "qa-team/config.json"));
    expect(toolConfig).toMatchObject({ name: "qa-team", members: [], description: "coverage slice" });
    expect(logs.join("\n")).toContain("team 'qa-team' created");

    expect(() => lifecycle.cmdTeamCreate("qa-team")).toThrow("team 'qa-team' already exists");
  });

  test("spawn writes past-life context, updates manifests, and prints manual command by default", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    const mailbox = join(root, "ψ/memory/mailbox/reviewer");
    mkdirSync(mailbox, { recursive: true });
    writeFileSync(join(mailbox, "standing-orders.md"), "Always verify behavior.");
    writeFileSync(join(mailbox, "2026_findings.md"), Array.from({ length: 35 }, (_, i) => `finding-${i}`).join("\n"));

    await lifecycle.cmdTeamSpawn("qa-team", "reviewer", { model: "opus", prompt: "Inspect the diff", cwd: "/tmp/work dir" });

    const prompt = readFileSync(join(root, "ψ/memory/mailbox/teams/qa-team/reviewer-spawn-prompt.md"), "utf-8");
    expect(prompt).toContain("You are 'reviewer' on team 'qa-team'.");
    expect(prompt).toContain("Inspect the diff");
    expect(prompt).toContain("Always verify behavior.");
    expect(prompt).toContain("finding-34");
    expect(prompt).not.toContain("finding-0");
    expect(json(join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json")).members).toEqual(["reviewer"]);
    expect(json(join(teamsDir, "qa-team/config.json")).members).toEqual([{ name: "reviewer", model: "opus" }]);
    expect(logs.join("\n")).toContain("past life: yes");
    expect(logs.join("\n")).toContain("cd '/tmp/work dir' && claude --model opus");
  });

  test("spawn still succeeds when launch prompt mirror cannot write to the tool store", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    rmSync(join(teamsDir, "qa-team"), { recursive: true, force: true });
    writeFileSync(join(teamsDir, "qa-team"), "not a directory");

    await lifecycle.cmdTeamSpawn("qa-team", "reviewer", { model: "opus" });

    const vaultPromptPath = join(root, "ψ/memory/mailbox/teams/qa-team/reviewer-spawn-prompt.md");
    expect(readFileSync(vaultPromptPath, "utf-8")).toBe("You are 'reviewer' on team 'qa-team'.");
    expect(json(join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json")).members).toEqual(["reviewer"]);
    expect(logs.join("\n")).toContain("--system-prompt-file");
    expect(logs.join("\n")).toContain("ψ/memory/mailbox/teams/qa-team/reviewer-spawn-prompt.md");
  });

  test("spawn --exec outside tmux leaves a manual command instead of spawning", async () => {
    lifecycle.cmdTeamCreate("qa-team");

    await lifecycle.cmdTeamSpawn("qa-team", "builder", { exec: true, model: "sonnet" });

    expect(layoutCalls).toEqual([]);
    expect(logs.join("\n")).toContain("--exec requires an active tmux session");
    expect(logs.join("\n")).toContain("Run manually:");
  });

  test("spawn --exec inside tmux records pane metadata and saves a layout snapshot", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    process.env.TMUX = "/tmp/tmux,1,0";
    process.env.TMUX_PANE = "%leader";
    spawnResult = { paneId: "%42", color: "green" };

    await lifecycle.cmdTeamSpawn("qa-team", "builder", { exec: true, model: "opus" });

    expect(layoutCalls[0]).toEqual(["spawnTeammatePane", "builder", expect.stringContaining("claude --model opus"), { colorIndex: 1 }]);
    expect(snapshotCalls).toEqual([["qa-team", "%leader"]]);
    const member = json(join(teamsDir, "qa-team/config.json")).members[0];
    expect(member).toMatchObject({ name: "builder", model: "opus", tmuxPaneId: "%42", color: "green", agentId: "builder@qa-team" });
    expect(logs.join("\n")).toContain("--exec");
  });

  test("spawn --exec launches from an ASCII prompt copy when the vault path contains Unicode", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    process.env.TMUX = "/tmp/tmux,1,0";
    process.env.TMUX_PANE = "%leader";

    await lifecycle.cmdTeamSpawn("qa-team", "builder-λ", { exec: true, model: "opus" });

    const command = (layoutCalls[0] as unknown[])[2] as string;
    expect(command).toContain("claude --model opus --system-prompt-file");
    expect(command).not.toContain("/ψ/");
    expect(command).not.toContain("λ");
    const launchFiles = readdirSync(join(teamsDir, "qa-team")).filter((name) => name.endsWith("-spawn-prompt.md"));
    expect(launchFiles).toHaveLength(1);
    expect(launchFiles[0]).not.toContain("λ");
    const launchPrompt = join(teamsDir, "qa-team", launchFiles[0]);
    expect(command).toContain(launchPrompt);
    expect(readFileSync(launchPrompt, "utf-8")).toContain("You are 'builder-λ' on team 'qa-team'.");
    expect(existsSync(join(root, "ψ/memory/mailbox/teams/qa-team/builder-λ-spawn-prompt.md"))).toBe(true);
  });

  test("spawn reports missing teams and falls back when pane creation fails", async () => {
    expect(lifecycle.cmdTeamSpawn("missing-team", "scout")).rejects.toThrow("team 'missing-team' not found");

    lifecycle.cmdTeamCreate("qa-team");
    process.env.TMUX = "/tmp/tmux,1,0";
    spawnTeammatePaneImpl = async (...args: unknown[]) => {
      layoutCalls.push(["spawnTeammatePane", ...args]);
      throw new Error("split denied");
    };

    await lifecycle.cmdTeamSpawn("qa-team", "scout", { exec: true, model: "haiku" });

    expect(layoutCalls[0]).toEqual(["spawnTeammatePane", "scout", expect.stringContaining("claude --model haiku"), { colorIndex: 1 }]);
    expect(logs.join("\n")).toContain("--exec split failed: split denied");
    expect(logs.join("\n")).toContain("Run manually:");
  });

  test("mergeTeamKnowledge copies dead members' inboxes, findings, and archived manifest", () => {
    const teamDir = makeToolTeam("qa-team", [{ name: "scout" }]);
    mkdirSync(join(teamDir, "inboxes"), { recursive: true });
    writeFileSync(join(teamDir, "inboxes/scout.json"), JSON.stringify([{ text: "hello" }]));
    mkdirSync(join(teamDir, "scout"), { recursive: true });
    writeFileSync(join(teamDir, "scout/notes_findings.md"), "found a thing");

    lifecycle.mergeTeamKnowledge("qa-team", [{ name: "scout" }]);

    expect(readFileSync(join(root, "ψ/memory/mailbox/scout/team-qa-team-inbox.json"), "utf-8")).toContain("hello");
    expect(readFileSync(join(root, "ψ/memory/mailbox/scout/notes_findings.md"), "utf-8")).toBe("found a thing");
    expect(json(join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json")).name).toBe("qa-team");
  });

  test("shutdown returns early when a team has no non-lead teammates", async () => {
    makeToolTeam("lead-only", [{ name: "leader", agentType: "team-lead", tmuxPaneId: "%0" }]);

    await lifecycle.cmdTeamShutdown("lead-only");

    expect(logs.join("\n")).toContain("No teammates to shut down");
    expect(existsSync(join(teamsDir, "lead-only/config.json"))).toBe(true);
  });

  test("shutdown with --merge preserves knowledge even when all teammates already exited", async () => {
    const teamDir = makeToolTeam("qa-team", [{ name: "scout", tmuxPaneId: "%9" }]);
    mkdirSync(join(teamDir, "inboxes"), { recursive: true });
    writeFileSync(join(teamDir, "inboxes/scout.json"), JSON.stringify([{ text: "dead state" }]));
    paneSnapshots = [new Set()];

    await lifecycle.cmdTeamShutdown("qa-team", { merge: true });

    expect(existsSync(teamDir)).toBe(false);
    expect(readFileSync(join(root, "ψ/memory/mailbox/scout/team-qa-team-inbox.json"), "utf-8")).toContain("dead state");
    expect(logs.join("\n")).toContain("already exited");
    expect(logs.join("\n")).toContain("knowledge merged");
  });

  test("shutdown sends inbox requests, force-kills stragglers, cleans leftover panes, merges, and removes config", async () => {
    const teamDir = makeToolTeam("qa-team", [
      { name: "scout", tmuxPaneId: "%1" },
      { name: "builder", tmuxPaneId: "%2" },
      { name: "local", tmuxPaneId: "in-process" },
    ]);
    cleanupReturn = 2;
    paneSnapshots = [new Set(["%1", "%2"]), new Set(["%2"]), new Set(["%2"])] as Array<Set<string>>;
    const nowValues = [100, 101, 0, 26_000, 26_000];
    Date.now = () => nowValues.shift() ?? 26_000;
    process.env.TMUX_PANE = "%leader";

    await lifecycle.cmdTeamShutdown("qa-team", { force: true, merge: true });

    expect(killPaneCalls).toEqual(["%2"]);
    expect(layoutCalls).toContainEqual(["cleanupTeamPanes", "%leader", ["%1", "%2", "in-process"], { hide: false }]);
    expect(existsSync(teamDir)).toBe(false);
    expect(logs.join("\n")).toContain("scout shut down gracefully");
    expect(logs.join("\n")).toContain("force-killed builder");
    expect(logs.join("\n")).toContain("team 'qa-team' shut down (knowledge merged)");
  });

  test("shutdown reports missing teams, send failures, and still-live panes without force", async () => {
    expect(lifecycle.cmdTeamShutdown("missing-team")).rejects.toThrow("team not found: missing-team");

    const teamDir = makeToolTeam("qa-team", [{ name: "scout", tmuxPaneId: "%1" }]);
    cleanupReturn = 1;
    sendShutdownImpl = (...args: unknown[]) => {
      sendShutdownCalls.push(args);
      Date.now();
      throw new Error("inbox locked");
    };
    paneSnapshots = [new Set(["%1"]), new Set(["%1"]), new Set(["%1"])] as Array<Set<string>>;
    const nowValues = [0, 1, 26_000, 26_000];
    Date.now = () => nowValues.shift() ?? 26_000;
    process.env.TMUX_PANE = "%leader";

    await lifecycle.cmdTeamShutdown("qa-team");

    expect(sendShutdownCalls).toEqual([["qa-team", "scout", "team teardown via maw team shutdown"]]);
    expect(killPaneCalls).toEqual([]);
    expect(layoutCalls).toContainEqual(["cleanupTeamPanes", "%leader", ["%1"], { hide: true }]);
    expect(errors.join("\n")).toContain("failed to send shutdown to scout: Error: inbox locked");
    expect(errors.join("\n")).toContain("scout did not respond to shutdown_request");
    expect(logs.join("\n")).toContain("hidden 1 leftover pane");
    expect(existsSync(teamDir)).toBe(false);
  });
});
