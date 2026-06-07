import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir as realTmpdir } from "node:os";
import { dirname, join } from "path";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

const realCwd = process.cwd();
const realPath = process.env.PATH ?? "";
const realHome = process.env.HOME;
let homeDir = mkdtempSync(join(realTmpdir(), "maw-team-more-home-"));
let teamsDir = mkdtempSync(join(realTmpdir(), "maw-team-more-teams-"));
let tasksDir = mkdtempSync(join(realTmpdir(), "maw-team-more-tasks-"));

const calls: Record<string, unknown[][]> = {
  cmdTeamCreate: [],
  cmdTeamSpawn: [],
  cmdTeamSend: [],
  cmdTeamResume: [],
  cmdTeamLives: [],
  cmdTeamShutdown: [],
  cmdTeamList: [],
  cmdTeamTaskAdd: [],
  cmdTeamTaskList: [],
  cmdTeamTaskDone: [],
  cmdTeamTaskAssign: [],
  cmdOracleInvite: [],
  cmdOracleRemove: [],
  hostExec: [],
  withPaneLock: [],
  applyTiledLayout: [],
  applyTeamLayout: [],
  enableBorderStatus: [],
  stylePaneBorder: [],
  getWindowTarget: [],
  loadLayoutSnapshot: [],
};

let hostExecQueue: Array<string | Error> = [];
let snapshot: any = null;


mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.cmdTeamCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => calls.cmdTeamSpawn.push(args),
  cmdTeamSend: (...args: unknown[]) => calls.cmdTeamSend.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.cmdTeamResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.cmdTeamLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => calls.cmdTeamShutdown.push(args),
  cmdTeamList: () => {
    calls.cmdTeamList.push([]);
    console.error("listed on stderr");
  },
}));

mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.cmdTeamTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => calls.cmdTeamTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => calls.cmdTeamTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.cmdTeamTaskAssign.push(args),
}));

mock.module(at("../../src/commands/plugins/team/oracle-members"), () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.cmdOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.cmdOracleRemove.push(args),
  cmdOracleMembers: () => {},
}));

mock.module(at("../../src/cli/parse-args"), () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    for (let i = startIndex; i < args.length; i++) {
      const token = args[i] ?? "";
      if (token in schema) {
        const type = schema[token];
        if (type === Boolean) out[token] = true;
        else if (type === Number) { out[token] = Number(args[i + 1] ?? 0); i++; }
        else { out[token] = args[i + 1] ?? ""; i++; }
      } else {
        (out._ as string[]).push(token);
      }
    }
    return out;
  },
}));

mock.module(at("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    calls.hostExec.push([cmd]);
    const next = hostExecQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  withPaneLock: async (fn: () => Promise<void>) => {
    calls.withPaneLock.push([]);
    return fn();
  },
}));

mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (i: number) => ["red", "green", "blue"][i] ?? "white",
  colorAnsi: (color: string) => ({ red: "31", green: "32", blue: "34", white: "37" } as Record<string, string>)[color] ?? "35",
  stylePaneBorder: async (...args: unknown[]) => calls.stylePaneBorder.push(args),
  enableBorderStatus: async (...args: unknown[]) => calls.enableBorderStatus.push(args),
  applyTeamLayout: async (...args: unknown[]) => calls.applyTeamLayout.push(args),
  applyTiledLayout: async (...args: unknown[]) => calls.applyTiledLayout.push(args),
  getWindowTarget: async (...args: unknown[]) => { calls.getWindowTarget.push(args); return "win:more"; },
}));

mock.module(at("../../src/commands/plugins/team/layout-snapshot"), () => ({
  loadLayoutSnapshot: (...args: unknown[]) => {
    calls.loadLayoutSnapshot.push(args);
    return snapshot;
  },
}));

process.env.HOME = homeDir;
const helpers = await import("../../src/commands/plugins/team/team-helpers");
const { default: teamHandler } = await import("../../src/commands/plugins/team/index");

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
}

function resetEnv() {
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.PATH = realPath;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeHomeTeamConfig(teamName: string) {
  writeJson(join(homeDir, ".claude", "teams", teamName, "config.json"), { name: teamName, members: [] });
}

function installFakeTmux(sessionName: string) {
  const binDir = join(homeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const tmuxPath = join(binDir, "tmux");
  writeFileSync(tmuxPath, `#!/bin/sh\nprintf '%s\\n' '${sessionName}'\n`);
  chmodSync(tmuxPath, 0o755);
  process.env.PATH = `${binDir}:${realPath}`;
}

beforeEach(() => {
  resetCalls();
  resetEnv();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(teamsDir, { recursive: true, force: true });
  rmSync(tasksDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(realTmpdir(), "maw-team-more-home-"));
  process.env.HOME = homeDir;
  teamsDir = mkdtempSync(join(realTmpdir(), "maw-team-more-teams-"));
  tasksDir = mkdtempSync(join(realTmpdir(), "maw-team-more-tasks-"));
  helpers._setDirs(teamsDir, tasksDir);
  hostExecQueue = [];
  snapshot = null;
});

afterEach(() => {
  resetEnv();
  try { process.chdir(realCwd); } catch {}
});

describe("team helper isolated branch coverage", () => {
  test("loadTeam handles missing, malformed, and valid config files", () => {
    expect(helpers.loadTeam("missing")).toBeNull();

    const badPath = join(teamsDir, "bad", "config.json");
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, "{");
    expect(helpers.loadTeam("bad")).toBeNull();

    writeJson(join(teamsDir, "ok", "config.json"), { name: "ok", members: [{ name: "a" }] });
    expect(helpers.loadTeam("ok")?.members[0]?.name).toBe("a");
  });

  test("resolvePsi walks up to an oracle root and falls back to cwd psi", () => {
    const root = mkdtempSync(join(realTmpdir(), "maw-team-more-psi-"));
    const nested = join(root, "packages", "cli");
    mkdirSync(join(root, "ψ"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "oracle root");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(realpathSync(helpers.resolvePsi())).toBe(realpathSync(join(root, "ψ")));

    const plain = mkdtempSync(join(realTmpdir(), "maw-team-more-plain-"));
    process.chdir(plain);
    expect(realpathSync(dirname(helpers.resolvePsi()))).toBe(realpathSync(plain));
    expect(helpers.resolvePsi().endsWith("/ψ")).toBe(true);
  });

  test("message writers recover corrupt inboxes and cleanup ignores missing dirs", () => {
    const inboxDir = join(teamsDir, "alpha", "inboxes");
    mkdirSync(inboxDir, { recursive: true });
    const shutdownPath = join(inboxDir, "alice.json");
    writeFileSync(shutdownPath, "not-json");

    helpers.writeShutdownRequest("alpha", "alice", "wrap up");
    const shutdown = JSON.parse(readFileSync(shutdownPath, "utf-8"));
    expect(shutdown).toHaveLength(1);
    expect(JSON.parse(shutdown[0].text).type).toBe("shutdown_request");
    expect(shutdown[0].summary).toContain("wrap up");

    const msgPath = join(inboxDir, "bob.json");
    writeFileSync(msgPath, "not-json");
    helpers.writeMessage("alpha", "bob", "lead", "x".repeat(90));
    const messages = JSON.parse(readFileSync(msgPath, "utf-8"));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].text)).toEqual({ type: "message", content: "x".repeat(90) });
    expect(messages[0].summary).toHaveLength(80);

    writeJson(join(teamsDir, "alpha", "config.json"), { name: "alpha", members: [] });
    writeJson(join(tasksDir, "alpha", "tasks.json"), []);
    helpers.cleanupTeamDir("alpha");
    expect(existsSync(join(teamsDir, "alpha"))).toBe(false);
    expect(existsSync(join(tasksDir, "alpha"))).toBe(false);
    helpers.cleanupTeamDir("alpha");
  });
});

describe("team index isolated missing branch coverage", () => {
  test("usage errors cover remaining direct argument guards", async () => {
    const cases: Array<[string[], string]> = [
      [["spawn", "team-only"], "team and role required"],
      [["send", "team", "agent"], "team, agent, and message required"],
      [["resume"], "name required"],
      [["history"], "agent name required"],
      [["down"], "name required"],
      [["oracle-invite"], "oracle name required"],
      [["oracle-remove"], "oracle name required"],
      [["send-enter"], "agent required"],
    ];

    for (const [args, error] of cases) {
      const result = await teamHandler({ source: "cli", args });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(error);
    }
  });

});
