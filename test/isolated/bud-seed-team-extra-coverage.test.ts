import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "../..");

let ghqRoot = "";
let config: any = { githubOrg: "Soul-Brews-Studio" };
let peersFile = "";
let spawnCalls: Array<{ team: string; member: string; opts: unknown }> = [];

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/internal/peers-store"), () => ({
  peersPath: () => peersFile,
}));

mock.module(join(root, "src/vendor/mpr-plugins/team/team-lifecycle"), () => ({
  cmdTeamSpawn: (team: string, member: string, opts: unknown) => {
    spawnCalls.push({ team, member, opts });
  },
}));

const seed = await import("../../src/vendor/mpr-plugins/bud/from-repo-seed.ts?bud-seed-extra");
const helpers = await import("../../src/vendor/mpr-plugins/team/team-helpers.ts?team-extra");
const reincarnationHelpers = await import("../../src/vendor/mpr-plugins/team/team-helpers");
const team = await import("../../src/vendor/mpr-plugins/team/team-reincarnation.ts?team-extra");

const original = {
  cwd: process.cwd(),
  log: console.log,
  envSession: process.env.CLAUDE_SESSION_ID,
};

let temp = "";
let logs: string[] = [];
let teamsDir = "";
let tasksDir = "";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "maw-bud-seed-team-"));
  ghqRoot = join(temp, "ghq");
  peersFile = join(temp, "peers.json");
  config = { githubOrg: "laris-co" };
  teamsDir = join(temp, "teams");
  tasksDir = join(temp, "tasks");
  helpers._setDirs(teamsDir, tasksDir);
  reincarnationHelpers._setDirs(teamsDir, tasksDir);
  mkdirSync(join(temp, "oracle", "ψ"), { recursive: true });
  process.chdir(join(temp, "oracle"));
  logs = [];
  spawnCalls = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  process.env.CLAUDE_SESSION_ID = "lead-now";
});

afterEach(() => {
  console.log = original.log;
  helpers._setDirs(join(process.env.HOME || original.cwd, ".claude/teams"), join(process.env.HOME || original.cwd, ".claude/tasks"));
  reincarnationHelpers._setDirs(join(process.env.HOME || original.cwd, ".claude/teams"), join(process.env.HOME || original.cwd, ".claude/tasks"));
  process.chdir(original.cwd);
  if (original.envSession === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = original.envSession;
  if (temp && existsSync(temp)) rmSync(temp, { recursive: true, force: true });
});

describe("bud seed helpers extra coverage", () => {
  test("resolves parent memory path from configured org and ghq root", () => {
    expect(seed.parentMemoryPath("pulse")).toBe(join(ghqRoot, "github.com", "laris-co", "pulse-oracle", "ψ", "memory"));
  });

  test("seedFromParent logs missing and non-directory parents before copying memory", () => {
    const target = join(temp, "target");
    const log = (msg: string) => logs.push(msg);

    seed.seedFromParent(target, "missing", log);
    expect(logs.join("\n")).toContain("has no ψ/memory");

    const parentMemory = seed.parentMemoryPath("fileparent");
    mkdirSync(join(parentMemory, ".."), { recursive: true });
    writeFileSync(parentMemory, "not a dir");
    seed.seedFromParent(target, "fileparent", log);
    expect(logs.join("\n")).toContain("not a directory");

    const realMemory = seed.parentMemoryPath("real");
    mkdirSync(realMemory, { recursive: true });
    writeFileSync(join(realMemory, "note.md"), "remember");
    seed.seedFromParent(target, "real", log);
    expect(readFileSync(join(target, "ψ", "memory", "note.md"), "utf8")).toBe("remember");
    expect(logs.join("\n")).toContain("copied parent real");
  });

  test("copyPeersSnapshot logs missing peers and copies present peers", () => {
    const target = join(temp, "target-peers");
    const log = (msg: string) => logs.push(msg);

    seed.copyPeersSnapshot(target, log);
    expect(logs.join("\n")).toContain("no peers.json");

    writeFileSync(peersFile, JSON.stringify([{ name: "white" }]));
    seed.copyPeersSnapshot(target, log);
    expect(readFileSync(join(target, "ψ", "peers.json"), "utf8")).toContain("white");
    expect(logs.join("\n")).toContain("snapshot peers.json");
  });
});

describe("team reincarnation extra coverage", () => {
  test("resume claims orphaned live teams without requiring an archive manifest", () => {
    writeJson(join(teamsDir, "claimed", "config.json"), {
      name: "claimed",
      leadSessionId: "old-lead-session-long",
      members: [
        { name: "leader", agentType: "team-lead", tmuxPaneId: "%0" },
        { name: "scout", tmuxPaneId: "%1" },
        { name: "builder", tmuxPaneId: "%2" },
      ],
    });

    team.cmdTeamResume("claimed");

    const output = logs.join("\n");
    expect(output).toContain("claimed orphaned team 'claimed'");
    expect(output).toContain("old lead: old-lead");
    expect(output).toContain("new lead: lead-now");
    expect(output).toContain("teammates: 2 (scout, builder)");
    expect(spawnCalls).toEqual([]);
  });

  test("resume reports the searched archive path when no team can be restored", () => {
    expect(() => team.cmdTeamResume("missing-team"))
      .toThrow("no archived team 'missing-team' found");
  });

  test("resume reports archived teams with no members", () => {
    writeJson(join(temp, "oracle", "ψ", "memory", "mailbox", "teams", "empty", "manifest.json"), { members: [] });

    team.cmdTeamResume("empty");

    expect(logs.join("\n")).toContain("Team 'empty' has no members to resume");
    expect(spawnCalls).toEqual([]);
  });

  test("resume spawns every archived member with the selected model", () => {
    writeJson(join(temp, "oracle", "ψ", "memory", "mailbox", "teams", "ops", "manifest.json"), { members: ["scout", "builder"] });

    team.cmdTeamResume("ops", { model: "gpt-test" });

    expect(spawnCalls).toEqual([
      { team: "ops", member: "scout", opts: { model: "gpt-test" } },
      { team: "ops", member: "builder", opts: { model: "gpt-test" } },
    ]);
    expect(logs.join("\n")).toContain("team 'ops' resumed — 2 agent(s) reincarnated");
  });

  test("team lives reports missing, orders, findings, and other files", () => {
    team.cmdTeamLives("ghost");
    expect(logs.join("\n")).toContain("No past lives found for 'ghost'");

    logs = [];
    const mailbox = join(temp, "oracle", "ψ", "memory", "mailbox", "scout");
    mkdirSync(mailbox, { recursive: true });
    writeFileSync(join(mailbox, "standing-orders.md"), "always test");
    writeFileSync(join(mailbox, "alpha_findings.md"), "one\ntwo");
    writeFileSync(join(mailbox, "misc.json"), "{}");

    team.cmdTeamLives("scout");

    const output = logs.join("\n");
    expect(output).toContain("standing orders:");
    expect(output).toContain("findings:");
    expect(output).toContain("alpha_findings.md (2 lines)");
    expect(output).toContain("other:");
    expect(output).toContain("misc.json");
  });

  test("team lives reports no orders and no findings for sparse mailboxes", () => {
    const mailbox = join(temp, "oracle", "ψ", "memory", "mailbox", "minimal");
    mkdirSync(mailbox, { recursive: true });
    writeFileSync(join(mailbox, "note.json"), "{}");

    team.cmdTeamLives("minimal");

    const output = logs.join("\n");
    expect(output).toContain("standing orders:");
    expect(output).toContain("no");
    expect(output).toContain("findings:");
    expect(output).toContain("none");
    expect(output).toContain("note.json");
  });
});
