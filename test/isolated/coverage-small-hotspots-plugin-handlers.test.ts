import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Shared SDK mock for vendor handlers that import through the package export.
type MockSession = { name: string; windows: Array<{ index: number }> };
let sessions: MockSession[] = [];
const sdkCalls = { hostExec: [] as string[] };

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => {
    sdkCalls.hostExec.push(cmd);
    if (cmd.includes("display-message")) return "pane-title\n";
    if (cmd.includes("show-options")) return "@role operator\n";
    return "";
  },
  tmuxCmd: () => "tmux-test",
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (raw: string, available: MockSession[]) => {
    const matches = available.filter((s) => s.name === raw || s.name.startsWith(raw));
    if (matches.length === 1) return { kind: "ok", match: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
    return { kind: "none", hints: available.slice(0, 2) };
  },
}));

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (args: string[], schema: Record<string, unknown>, startIndex = 0) => {
    const out: Record<string, unknown> = { _: [] as string[] };
    const aliases = Object.entries(schema)
      .filter(([, value]) => typeof value === "string")
      .reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = value as string;
        return acc;
      }, {});

    for (let i = startIndex; i < args.length; i++) {
      const raw = args[i] ?? "";
      const token = aliases[raw] ?? raw;
      if (token in schema) {
        const valueType = schema[token];
        if (valueType === Boolean) out[token] = true;
        else if (valueType === Number) { out[token] = Number(args[i + 1] ?? 0); i++; }
        else { out[token] = args[i + 1] ?? ""; i++; }
      } else {
        (out._ as string[]).push(raw);
      }
    }
    return out;
  },
}));

// Fleet handler mocks.
const fleetPath = import.meta.resolve("../../src/commands/shared/fleet");
let fleetLsCalls = 0;
mock.module(fleetPath, () => ({
  cmdFleetLs: async () => {
    fleetLsCalls += 1;
    console.error("fleet stderr");
  },
}));

// Session handler host execution mock via SDK's underlying transport export.
const sshPath = import.meta.resolve("../../src/core/transport/ssh.ts");
const sdkIndexPath = import.meta.resolve("../../src/sdk/index.ts");
let sessionHostExecCalls: string[] = [];
const sessionSdkMock = () => ({
  hostExec: async (cmd: string) => {
    if (cmd.includes("#S")) {
      sessionHostExecCalls.push(cmd);
      console.error("session stderr");
      return "session-alpha\n";
    }
    sdkCalls.hostExec.push(cmd);
    if (cmd.includes("display-message")) return "pane-title\n";
    if (cmd.includes("show-options")) return "@role operator\n";
    return "";
  },
  listSessions: async () => sessions,
  tmuxCmd: () => "tmux-test",
  capture: async () => "",
  sendKeys: async () => undefined,
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => [],
  isAgentCommand: () => false,
  HostExecError: class HostExecError extends Error {},
});
mock.module(sshPath, sessionSdkMock);
mock.module(sdkIndexPath, sessionSdkMock);

// Wake handler mocks.
const peerResolvePath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts");
const peerCallPath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts");
let peer: { url: string; node: string | null } | null = null;
let peerResult: { ok: boolean; status?: number; data?: any } = { ok: true, data: {} };
const peerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
mock.module("maw-js/commands/shared/wake", () => ({ cmdWake: async () => undefined }));
mock.module("maw-js/commands/shared/fleet", () => ({ cmdWakeAll: async () => undefined }));
mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => undefined,
}));
mock.module("maw-js/commands/shared/wake-resolve", () => ({
  fetchGitHubPrompt: async () => "prompt",
}));
mock.module(peerResolvePath, () => ({ resolvePeer: () => peer }));
mock.module(peerCallPath, () => ({
  callPeerWake: async (url: string, body: Record<string, unknown>) => {
    peerCalls.push({ url, body });
    return peerResult;
  },
}));

// Scope handler mock.
const scopeImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/scope/impl.ts");
let scopeCreateError: Error | null = null;
let scopeListError: Error | null = null;
mock.module(scopeImplPath, () => ({
  cmdList: () => { if (scopeListError) throw scopeListError; return []; },
  formatList: () => "no scopes",
  cmdCreate: ({ name, members }: { name: string; members: string[] }) => {
    if (scopeCreateError) throw scopeCreateError;
    return { name, members };
  },
  scopePath: (name: string) => `/tmp/${name}.json`,
  cmdShow: () => null,
  cmdDelete: () => false,
}));

// Team handler mocks.
const teamImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/impl.ts");
const teamCharterPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/team-charter.ts");
const teamTaskOpsPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/task-ops.ts");
const teamCommsPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/team-comms.ts");
const teamCalls: Record<string, unknown[][]> = { taskAdd: [], preflight: [] };
let homeDir = mkdtempSync(join(tmpdir(), "maw-team-hotspot-"));
let preflightErrors: string[] = [];
mock.module("os", () => ({ homedir: () => homeDir }));
const teamImplExports: Record<string, unknown> = {
  cmdTeamShutdown: async () => undefined,
  cmdTeamList: async () => undefined,
  cmdTeamCreate: () => undefined,
  cmdTeamSpawn: async () => undefined,
  cmdTeamSend: () => undefined,
  cmdTeamBroadcast: async () => undefined,
  ["cmdTeam" + "B" + "ring"]: async () => undefined,
  cmdTeamResume: () => undefined,
  cmdTeamLives: () => undefined,
};
mock.module(teamImplPath, () => teamImplExports);
mock.module(teamCommsPath, () => ({
  resolveTeamSendMode: () => ({ mode: "broadcast", message: "" }),
  teamMessageTargets: () => [],
}));
mock.module(teamCharterPath, () => ({
  readTeamCharter: (path: string) => ({ path }),
  planTeamCharter: (charter: unknown) => charter,
  formatTeamCharterPlan: () => "plan",
  preflightTeamCharter: (...args: unknown[]) => { teamCalls.preflight.push(args); return { errors: preflightErrors }; },
  formatTeamCharterPreflight: ({ errors }: { errors: string[] }) => `preflight:${errors.length}`,
  loadTeamCharter: () => ({}),
  formatTeamCharterLoad: () => "load",
  spawnFromTeamCharter: async () => ({}),
  formatTeamCharterSpawn: () => "spawn",
}));
mock.module(teamTaskOpsPath, () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => teamCalls.taskAdd.push(args),
  cmdTeamTaskList: () => undefined,
  cmdTeamTaskDone: () => undefined,
  cmdTeamTaskAssign: () => undefined,
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-status.ts"), () => ({ cmdTeamStatus: async () => undefined }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-cleanup.ts"), () => ({ cmdTeamDelete: async () => undefined }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-invite.ts"), () => ({ cmdTeamInvite: async () => undefined }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/oracle-members.ts"), () => ({
  cmdOracleInvite: () => undefined,
  cmdOracleRemove: () => undefined,
  cmdOracleMembers: () => undefined,
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-helpers.ts"), () => ({ loadTeam: () => undefined }));

const originalTmux = process.env.TMUX;
const originalTeam = process.env.MAW_TEAM;
const originalSpawnSync = Bun.spawnSync;

function resetHome() {
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-team-hotspot-"));
}

function writeTeamConfig(name: string) {
  const dir = join(homeDir, ".claude", "teams", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name }));
}

beforeEach(() => {
  sessions = [];
  sdkCalls.hostExec = [];
  fleetLsCalls = 0;
  sessionHostExecCalls = [];
  peer = null;
  peerResult = { ok: true, data: {} };
  peerCalls.length = 0;
  scopeCreateError = null;
  scopeListError = null;
  teamCalls.taskAdd = [];
  teamCalls.preflight = [];
  preflightErrors = [];
  if (originalTmux === undefined) delete process.env.TMUX; else process.env.TMUX = originalTmux;
  if (originalTeam === undefined) delete process.env.MAW_TEAM; else process.env.MAW_TEAM = originalTeam;
  Bun.spawnSync = originalSpawnSync;
  resetHome();
});

describe("small hotspot plugin handler coverage", () => {
  test("fleet and session writer paths capture stderr from delegated work", async () => {
    const { default: fleetHandler } = await import("../../src/commands/plugins/fleet/index.ts?coverage-small-hotspots-fleet");
    const fleetWrites: string[] = [];
    const fleetResult = await fleetHandler({
      source: "cli",
      args: ["ls"],
      writer: (...parts: unknown[]) => fleetWrites.push(parts.map(String).join(" ")),
    } as any);
    expect(fleetResult.ok).toBe(true);
    expect(fleetLsCalls).toBe(1);
    expect(fleetWrites).toEqual(["fleet stderr"]);

    process.env.TMUX = "/tmp/tmux.sock,1,2";
    const { default: sessionHandler } = await import("../../src/commands/plugins/session/index.ts?coverage-small-hotspots-session");
    const sessionWrites: string[] = [];
    const sessionResult = await sessionHandler({
      source: "cli",
      args: [],
      writer: (...parts: unknown[]) => sessionWrites.push(parts.map(String).join(" ")),
    } as any);
    expect(sessionResult.ok).toBe(true);
    expect(sessionHostExecCalls[0]).toContain("tmux display-message");
    expect(sessionWrites).toEqual(["session stderr", "session-alpha"]);
  });

  test("pane metadata read mode reports fallback guidance when no hints exist", async () => {
    const { cmdTag } = await import("../../src/vendor/mpr-plugins/tag/impl.ts?coverage-small-hotspots-pane-meta");
    sessions = [];
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      await expect(cmdTag("missing")).rejects.toThrow(/session 'missing' not found/);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toContain("try: maw ls");
  });

  test("peer forwarding covers empty success output and failure without details", async () => {
    const { default: wakeHandler } = await import("../../src/vendor/mpr-plugins/wake/index.ts?coverage-small-hotspots-wake");
    peer = { url: "http://peer", node: null };

    let result = await wakeHandler({ source: "cli", args: ["neo", "task", "--peer", "peer"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("forwarded wake");
    expect(result.output).not.toContain("undefined");
    expect(peerCalls[0]).toEqual({ url: "http://peer", body: { oracle: "neo", task: "task" } });

    peerResult = { ok: false, data: {} };
    result = await wakeHandler({ source: "cli", args: ["neo", "--peer", "peer"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no response");
  });

  test("scope handler returns local create errors and outer dispatcher errors", async () => {
    const { default: scopeHandler } = await import("../../src/vendor/mpr-plugins/scope/index.ts?coverage-small-hotspots-scope");
    scopeCreateError = new Error("create denied");
    let result = await scopeHandler({ source: "cli", args: ["create", "alpha", "--members", "one"] } as any);
    expect(result).toMatchObject({ ok: false, error: "create denied" });

    scopeCreateError = null;
    scopeListError = new Error("list exploded");
    result = await scopeHandler({ source: "cli", args: ["list"] } as any);
    expect(result).toMatchObject({ ok: false, error: "list exploded" });
  });

  test("team handler resolves context from tmux session and reports preflight failures", async () => {
    const { default: teamHandler } = await import("../../src/vendor/mpr-plugins/team/index.ts?coverage-small-hotspots-team");
    process.env.TMUX = "/tmp/tmux.sock,1,2";
    writeTeamConfig("context-team");
    Bun.spawnSync = ((..._args: unknown[]) => ({
      stdout: Buffer.from("01-context-team\n"),
      stderr: Buffer.from(""),
      exitCode: 0,
      success: true,
    })) as typeof Bun.spawnSync;

    let result = await teamHandler({ source: "cli", args: ["add", "cover", "hotspot"] } as any);
    expect(result.ok).toBe(true);
    expect(teamCalls.taskAdd).toEqual([["context-team", "cover hotspot", { assign: undefined, description: undefined }]]);

    preflightErrors = ["missing role"];
    result = await teamHandler({ source: "cli", args: ["check", "team.yaml"] } as any);
    expect(result).toEqual({ ok: false, error: "preflight failed", output: "preflight:1" });
  });
});
