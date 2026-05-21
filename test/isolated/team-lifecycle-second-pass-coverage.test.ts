import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let paneSnapshots: Array<Set<string>> = [];
let killPaneCalls: string[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<void> = async (cmd: string) => { hostExecCalls.push(cmd); };

const tmuxMock = {
  listPaneIds: async () => paneSnapshots.shift() ?? new Set<string>(),
  killPane: async (paneId: string) => { killPaneCalls.push(paneId); },
};

mock.module("maw-js/sdk", () => ({
  tmux: tmuxMock,
  hostExec: async (cmd: string) => hostExecImpl(cmd),
}));

const helpers = await import("../../src/vendor/mpr-plugins/team/team-helpers");
const lifecycle = await import("../../src/vendor/mpr-plugins/team/team-lifecycle");
const reincarnation = await import("../../src/vendor/mpr-plugins/team/team-reincarnation");

const original = {
  cwd: process.cwd(),
  log: console.log,
  error: console.error,
  tmux: process.env.TMUX,
  tmuxPane: process.env.TMUX_PANE,
  claudeSessionId: process.env.CLAUDE_SESSION_ID,
  setTimeout: globalThis.setTimeout,
  dateNow: Date.now,
};

let root = "";
let teamsDir = "";
let tasksDir = "";
let logs: string[] = [];
let errors: string[] = [];

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function makeOracleRoot() {
  root = mkdtempSync(join(tmpdir(), "maw-vendor-team-lifecycle-"));
  mkdirSync(join(root, "ψ"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "vendor team lifecycle coverage\n");
  teamsDir = join(root, "tool-teams");
  tasksDir = join(root, "tool-tasks");
  helpers._setDirs(teamsDir, tasksDir);
  process.chdir(root);
}

function makeToolTeam(name: string, members: any[] = []) {
  const teamDir = join(teamsDir, name);
  mkdirSync(teamDir, { recursive: true });
  writeJson(join(teamDir, "config.json"), { name, description: "", members, createdAt: 1 });
  return teamDir;
}

beforeEach(() => {
  makeOracleRoot();
  logs = [];
  errors = [];
  paneSnapshots = [];
  killPaneCalls = [];
  hostExecCalls = [];
  hostExecImpl = async (cmd: string) => { hostExecCalls.push(cmd); };
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
  if (original.claudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = original.claudeSessionId;
  globalThis.setTimeout = original.setTimeout;
  Date.now = original.dateNow;
  helpers._setDirs(join(process.env.HOME || original.cwd, ".claude/teams"), join(process.env.HOME || original.cwd, ".claude/tasks"));
  process.chdir(original.cwd);
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("vendor team-lifecycle second-pass coverage", () => {
  test("create snapshots the current lead session id for later orphan detection", () => {
    process.env.CLAUDE_SESSION_ID = "lead-session-original";

    lifecycle.cmdTeamCreate("claimable");

    expect(readJson(join(teamsDir, "claimable/config.json")).leadSessionId).toBe("lead-session-original");
    expect(readJson(join(root, "ψ/memory/mailbox/teams/claimable/manifest.json")).leadSessionId).toBe("lead-session-original");
  });

  test("create rejects duplicate archived manifests", () => {
    lifecycle.cmdTeamCreate("claimable");

    expect(() => lifecycle.cmdTeamCreate("claimable")).toThrow("team 'claimable' already exists");
  });

  test("resume auto-claims an orphaned tool-store team for the current lead session", () => {
    process.env.CLAUDE_SESSION_ID = "new-lead-session-9999";
    makeToolTeam("ops", [
      { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
      { name: "volt", tmuxPaneId: "%1" },
      { name: "odin", tmuxPaneId: "%2" },
    ]);
    const configPath = join(teamsDir, "ops/config.json");
    const before = readJson(configPath);
    writeJson(configPath, { ...before, leadSessionId: "old-lead-session-1234" });

    reincarnation.cmdTeamResume("ops");

    const updated = readJson(configPath);
    expect(updated.leadSessionId).toBe("new-lead-session-9999");
    expect(typeof updated.leadClaimedAt).toBe("number");
    const output = logs.join("\n");
    expect(output).toContain("claimed orphaned team 'ops'");
    expect(output).toContain("old lead: old-lead");
    expect(output).toContain("new lead: new-lea");
    expect(output).toContain("teammates: 2 (volt, odin)");
  });

  test("resume reports already claimed teams without requiring an archived manifest", () => {
    process.env.CLAUDE_SESSION_ID = "same-lead-session";
    makeToolTeam("live", [{ name: "scout", tmuxPaneId: "%1" }]);
    const configPath = join(teamsDir, "live/config.json");
    writeJson(configPath, { ...readJson(configPath), leadSessionId: "same-lead-session" });

    reincarnation.cmdTeamResume("live");

    expect(readJson(configPath).leadSessionId).toBe("same-lead-session");
    expect(logs.join("\n")).toContain("team 'live' already claimed by this lead session");
  });

  test("merge handles missing inboxes/member dirs/manifests as a best-effort no-op per member", () => {
    lifecycle.mergeTeamKnowledge("ghost-team", [{ name: "scout" }, { name: "builder" }]);

    expect(existsSync(join(root, "ψ/memory/mailbox/scout"))).toBe(true);
    expect(existsSync(join(root, "ψ/memory/mailbox/builder"))).toBe(true);
    expect(existsSync(join(root, "ψ/memory/mailbox/scout/team-ghost-team-inbox.json"))).toBe(false);
    expect(existsSync(join(root, "ψ/memory/mailbox/teams/ghost-team/manifest.json"))).toBe(false);
    expect(logs.join("\n")).toContain("merged scout");
    expect(logs.join("\n")).toContain("merged builder");
  });

  test("merge copies inboxes, findings, and archived manifests when present", () => {
    const teamDir = makeToolTeam("qa-team", [{ name: "scout" }]);
    mkdirSync(join(teamDir, "inboxes"), { recursive: true });
    writeFileSync(join(teamDir, "inboxes/scout.json"), JSON.stringify([{ text: "state" }]));
    mkdirSync(join(teamDir, "scout"), { recursive: true });
    writeFileSync(join(teamDir, "scout/daily_findings.md"), "covered finding");

    lifecycle.mergeTeamKnowledge("qa-team", [{ name: "scout" }]);

    expect(readFileSync(join(root, "ψ/memory/mailbox/scout/team-qa-team-inbox.json"), "utf-8")).toContain("state");
    expect(readFileSync(join(root, "ψ/memory/mailbox/scout/daily_findings.md"), "utf-8")).toBe("covered finding");
    expect(readJson(join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json")).name).toBe("qa-team");
  });

  test("shutdown reports missing teams and shutdown write failures", async () => {
    expect(lifecycle.cmdTeamShutdown("missing-team")).rejects.toThrow("team not found: missing-team");

    makeToolTeam("qa-team", [{ name: "scout", tmuxPaneId: "%1" }]);
    paneSnapshots = [new Set(["%1"]), new Set()] as Array<Set<string>>;

    await lifecycle.cmdTeamShutdown("qa-team");

    expect(killPaneCalls).toEqual([]);
    expect(errors.join("\n")).toContain("failed to send shutdown to scout");
    expect(logs.join("\n")).toContain("team 'qa-team' shut down");
    expect(existsSync(join(teamsDir, "qa-team"))).toBe(false);
  });

  test("shutdown leaves lead-only teams alone", async () => {
    makeToolTeam("lead-only", [{ name: "lead", agentType: "team-lead", tmuxPaneId: "%0" }]);

    await lifecycle.cmdTeamShutdown("lead-only");

    expect(logs.join("\n")).toContain("No teammates to shut down in 'lead-only'");
    expect(existsSync(join(teamsDir, "lead-only/config.json"))).toBe(true);
  });

  test("shutdown without --force reports still-live panes instead of killing them", async () => {
    const teamDir = makeToolTeam("qa-team", [{ name: "scout", tmuxPaneId: "%1" }]);
    mkdirSync(join(teamDir, "inboxes"), { recursive: true });
    paneSnapshots = [new Set(["%1"]), new Set(["%1"]), new Set(["%1"])] as Array<Set<string>>;
    const nowValues = [0, 1, 26_000, 26_000];
    Date.now = () => nowValues.shift() ?? 26_000;

    await lifecycle.cmdTeamShutdown("qa-team");

    expect(killPaneCalls).toEqual([]);
    expect(errors.join("\n")).toContain("scout did not respond to shutdown_request");
    expect(existsSync(teamDir)).toBe(false);
  });

  test("shutdown --force kills stragglers and all-exited --merge still preserves knowledge", async () => {
    const forcedDir = makeToolTeam("force-team", [{ name: "scout", tmuxPaneId: "%1" }]);
    mkdirSync(join(forcedDir, "inboxes"), { recursive: true });
    paneSnapshots = [new Set(["%1"]), new Set(["%1"]), new Set(["%1"])] as Array<Set<string>>;
    const nowValues = [0, 1, 26_000, 26_000];
    Date.now = () => nowValues.shift() ?? 26_000;

    await lifecycle.cmdTeamShutdown("force-team", { force: true });

    expect(killPaneCalls).toEqual(["%1"]);
    expect(logs.join("\n")).toContain("force-killed scout");

    const exitedDir = makeToolTeam("exited-team", [{ name: "builder", tmuxPaneId: "%2" }]);
    mkdirSync(join(exitedDir, "inboxes"), { recursive: true });
    writeFileSync(join(exitedDir, "inboxes/builder.json"), JSON.stringify([{ text: "dead state" }]));
    paneSnapshots = [new Set()] as Array<Set<string>>;

    await lifecycle.cmdTeamShutdown("exited-team", { merge: true });

    expect(readFileSync(join(root, "ψ/memory/mailbox/builder/team-exited-team-inbox.json"), "utf-8")).toContain("dead state");
    expect(logs.join("\n")).toContain("already exited");
    expect(logs.join("\n")).toContain("cleaned up (knowledge merged)");
  });

  test("spawn covers missing teams, duplicate members, bad tool configs, and manual command defaults", async () => {
    expect(lifecycle.cmdTeamSpawn("missing-team", "scout")).rejects.toThrow("team 'missing-team' not found");

    lifecycle.cmdTeamCreate("qa-team");
    const manifestPath = join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json");
    writeJson(manifestPath, { ...readJson(manifestPath), members: ["scout"] });
    writeFileSync(join(teamsDir, "qa-team/config.json"), "{ not json");

    await lifecycle.cmdTeamSpawn("qa-team", "scout", { cwd: "/tmp/path with 'quote" });

    expect(readJson(manifestPath).members).toEqual(["scout"]);
    expect(readFileSync(join(root, "ψ/memory/mailbox/teams/qa-team/scout-spawn-prompt.md"), "utf-8")).toBe("You are 'scout' on team 'qa-team'.");
    expect(logs.join("\n")).toContain("past life: no");
    expect(logs.join("\n")).toContain("cd '/tmp/path with '\\''quote' && claude --model sonnet --system-prompt-file");
  });

  test("spawn falls back to the vault prompt when tool-store launch prompt mirroring fails", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    rmSync(join(teamsDir, "qa-team"), { recursive: true, force: true });
    writeFileSync(join(teamsDir, "qa-team"), "not a directory");

    await lifecycle.cmdTeamSpawn("qa-team", "scout", { model: "sonnet" });

    const vaultPromptPath = join(root, "ψ/memory/mailbox/teams/qa-team/scout-spawn-prompt.md");
    expect(readFileSync(vaultPromptPath, "utf-8")).toBe("You are 'scout' on team 'qa-team'.");
    expect(readJson(join(root, "ψ/memory/mailbox/teams/qa-team/manifest.json")).members).toEqual(["scout"]);
    expect(logs.join("\n")).toContain("--system-prompt-file");
    expect(logs.join("\n")).toContain("ψ/memory/mailbox/teams/qa-team/scout-spawn-prompt.md");
  });

  test("spawn includes past-life standing orders and only the latest findings tail", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    const mailbox = join(root, "ψ/memory/mailbox/reviewer");
    mkdirSync(mailbox, { recursive: true });
    writeFileSync(join(mailbox, "standing-orders.md"), "Keep regressions isolated.");
    writeFileSync(join(mailbox, "2026-05-17_findings.md"), "older");
    writeFileSync(join(mailbox, "2026-05-18_findings.md"), Array.from({ length: 35 }, (_, i) => `finding-${i}`).join("\n"));

    await lifecycle.cmdTeamSpawn("qa-team", "reviewer", { prompt: "Review shutdown coverage." });

    const prompt = readFileSync(join(root, "ψ/memory/mailbox/teams/qa-team/reviewer-spawn-prompt.md"), "utf-8");
    expect(prompt).toContain("Review shutdown coverage.");
    expect(prompt).toContain("Keep regressions isolated.");
    expect(prompt).toContain("finding-34");
    expect(prompt).not.toContain("finding-0");
    expect(logs.join("\n")).toContain("past life: yes");
  });

  test("spawn --exec uses hostExec inside tmux and falls back to the manual command when hostExec fails", async () => {
    lifecycle.cmdTeamCreate("qa-team");
    process.env.TMUX = "/tmp/tmux,1,0";

    await lifecycle.cmdTeamSpawn("qa-team", "builder-λ", { exec: true, model: "opus" });

    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toContain("tmux split-window -h -l 50%");
    expect(hostExecCalls[0]).toContain("claude --model opus --system-prompt-file");
    expect(hostExecCalls[0]).not.toContain("--prompt-file");
    expect(hostExecCalls[0]).not.toContain("/ψ/");
    expect(hostExecCalls[0]).not.toContain("λ");
    const launchFiles = readdirSync(join(teamsDir, "qa-team")).filter((name) => name.endsWith("-spawn-prompt.md"));
    expect(launchFiles).toHaveLength(1);
    expect(launchFiles[0]).not.toContain("λ");
    const launchPrompt = join(teamsDir, "qa-team", launchFiles[0]);
    expect(hostExecCalls[0]).toContain(launchPrompt);
    expect(readFileSync(launchPrompt, "utf-8")).toContain("You are 'builder-λ' on team 'qa-team'.");
    expect(existsSync(join(root, "ψ/memory/mailbox/teams/qa-team/builder-λ-spawn-prompt.md"))).toBe(true);
    expect(logs.join("\n")).toContain("--exec");

    logs = [];
    hostExecImpl = async (cmd: string) => {
      hostExecCalls.push(cmd);
      throw new Error("tmux denied");
    };

    await lifecycle.cmdTeamSpawn("qa-team", "reviewer", { exec: true, model: "haiku", cwd: "/tmp/work dir" });

    expect(hostExecCalls).toHaveLength(2);
    expect(logs.join("\n")).toContain("--exec split failed: tmux denied");
    expect(logs.join("\n")).toContain("Run manually:");
    expect(logs.join("\n")).toContain("cd '/tmp/work dir' && claude --model haiku --system-prompt-file");
  });

  test("spawn --exec outside tmux prints a manual command instead of starting a pane", async () => {
    lifecycle.cmdTeamCreate("qa-team");

    await lifecycle.cmdTeamSpawn("qa-team", "builder", { exec: true, model: "sonnet" });

    expect(hostExecCalls).toEqual([]);
    expect(logs.join("\n")).toContain("--exec requires an active tmux session");
    expect(logs.join("\n")).toContain("Run manually:");
    expect(logs.join("\n")).toContain("claude --model sonnet --system-prompt-file");
  });
});
