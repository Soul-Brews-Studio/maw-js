import { describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> = async () => "";
let configValue: Record<string, any> = { env: {}, commands: {}, sessions: {} };

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  FLEET_DIR: "/tmp/nonexistent-fleet-next-core",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecImpl(cmd);
  },
  curlFetch: async () => ({ ok: false }),
  tmux: {
    listSessions: async () => [],
    setEnvironment: async () => {},
    hasSession: async () => true,
    run: async () => "",
  },
  restoreTabOrder: async () => 0,
  takeSnapshot: async () => {},
  getPaneInfos: async () => ({}),
  isAgentCommand: (cmd: string) => ["claude", "codex", "node"].includes(cmd),
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  ...mockConfigModule(() => configValue),
  buildCommand: (name: string) => `run ${name}`,
  buildCommandInDir: (name: string, cwd: string) => `cd ${cwd} && run ${name}`,
  getEnvVars: () => configValue.env ?? {},
}));

mock.module(import.meta.resolve("../../src/core/ghq"), () => ({
  ghqFind: async () => "",
  ghqList: async () => [],
}));

const wakeSession = await import("../../src/commands/shared/wake-session.ts?coverage-next-core-wake-session-resolve");
const wakeResolve = await import("../../src/commands/shared/wake-resolve-impl.ts?coverage-next-core-wake-session-resolve");
const wakeCmd = await import("../../src/commands/shared/wake-cmd.ts?coverage-next-core-wake-session-resolve");

function reset() {
  hostExecCalls = [];
  hostExecImpl = async () => "";
  configValue = { env: {}, commands: {}, sessions: {} };
}

describe("coverage next wake-session", () => {
  test("named worktree creation reuses an existing branch without creating a new branch", async () => {
    reset();
    const localCalls: string[] = [];
    const result = await wakeSession.createWorktree(
      "/repo path/project-oracle",
      "/repo path",
      "project-oracle",
      "project",
      "stable-task",
      [],
      {
        named: true,
        hostExec: async (cmd: string) => { localCalls.push(cmd); return "ok"; },
        log: () => {},
      } as any,
    );

    expect(result).toEqual({ wtPath: "/repo path/project-oracle/agents/stable-task", windowName: "project-stable-task" });
    expect(localCalls).toContain("git -C '/repo path/project-oracle' show-ref --verify --quiet 'refs/heads/agents/stable-task'");
    expect(localCalls).toContain("git -C '/repo path/project-oracle' worktree add '/repo path/project-oracle/agents/stable-task' 'agents/stable-task'");
    expect(localCalls.some((cmd) => cmd.includes(" -b "))).toBe(false);
  });

  test("ensureSessionRunning retries idle shells with default commands and skips busy panes", async () => {
    reset();
    const sent: Array<[string, string]> = [];
    const retried = await wakeSession.ensureSessionRunning("sess", undefined, undefined, {
      tmux: {
        listWindows: async () => [
          { index: 1, name: "idle", active: false },
          { index: 2, name: "busy", active: false },
          { index: 3, name: "agent", active: false },
        ],
        getPaneCommands: async () => ({ "sess:idle": "zsh", "sess:busy": "sh", "sess:agent": "codex" }),
        sendText: async (target: string, text: string) => { sent.push([target, text]); },
      },
      hostExec: async (cmd: string) => {
        if (cmd.includes("busy") && cmd.includes("display-message")) return "777\n";
        if (cmd.includes("pgrep -P 777")) return "888\n";
        if (cmd.includes("display-message")) return "555\n";
        return "";
      },
      buildCommand: (name: string) => `launch ${name}`,
      cfgTimeout: () => 0,
      sleep: async () => {},
      log: () => {},
    } as any);

    expect(retried).toBe(1);
    expect(sent).toEqual([["sess:idle", "launch idle"]]);
  });
});

describe("coverage next wake resolver helpers", () => {
  test("worktree fallback handles git-common-dir variants and missing paths", async () => {
    reset();
    const scan = async () => [{ path: "/work/project-task", mainRepo: "/gh/Org/project-oracle" } as any];

    await expect(wakeResolve.resolveFromWorktrees(
      "project",
      scan,
      async () => "/gh/Org/project-oracle\n",
      (path: string) => path === "/gh/Org/project-oracle",
    )).resolves.toEqual({ repoPath: "/gh/Org/project-oracle", repoName: "project-oracle", parentDir: "/gh/Org" });

    await expect(wakeResolve.resolveFromWorktrees(
      "project",
      scan,
      async () => "/gh/Org/project-oracle/.git\n",
      () => false,
    )).resolves.toBeNull();

    await expect(wakeResolve.resolveFromWorktrees(
      "absent",
      scan,
      async () => { throw new Error("should not run"); },
      () => true,
    )).resolves.toBeNull();
  });

  test("local repo-name resolution distinguishes exact, fuzzy, ambiguous, and empty intents", () => {
    reset();
    const repos = [
      "/gh/Org/project-oracle",
      "/gh/Other/project-oracle",
      "/gh/Org/projector-oracle",
      "/gh/Org/notes",
    ];

    expect(wakeResolve.resolveLocalOracleRepoName("", repos)).toEqual({ kind: "none" });
    expect(wakeResolve.resolveLocalOracleRepoName("project-oracle", ["/gh/Org/project-oracle"])).toEqual({ kind: "exact", match: "project-oracle" });
    expect(wakeResolve.resolveLocalOracleRepoName("project", repos)).toMatchObject({ kind: "ambiguous" });
    expect(wakeResolve.resolveLocalOracleRepoName("jecto", repos)).toEqual({ kind: "fuzzy", match: "projector-oracle" });
    expect(wakeResolve.resolveLocalOracleRepoName("missing", repos)).toEqual({ kind: "none" });
  });

  test("findWorktrees uses scoped fallback search and reusable scan filters by scope", async () => {
    reset();
    hostExecImpl = async (cmd: string) => {
      if (cmd.startsWith("ls -d")) return "\n";
      if (cmd.startsWith("find ")) return "/parent/project-oracle.wt-9-task\n";
      return "";
    };

    await expect(wakeResolve.findWorktrees("/parent", "project-oracle", "task", "project-oracle")).resolves.toEqual([
      { path: "/parent/project-oracle.wt-9-task", name: "9-task" },
    ]);
    expect(hostExecCalls.some((cmd) => cmd.startsWith("find "))).toBe(true);

    const reusable = wakeResolve.findReusableWorktreeBySlug("/parent", "task", "project-oracle", {
      readdirSync: () => ["project-oracle.wt-2-task", "other-oracle.wt-1-task", "project-oracle.wt-3-task"] as any,
      statSync: (path: string) => ({ isDirectory: () => !path.includes("3-task") }) as any,
    });
    expect(reusable).toEqual({ path: "/parent/project-oracle.wt-2-task", name: "2-task" });

    expect(wakeResolve.findReusableWorktreeBySlug("/parent", "task", undefined, {
      readdirSync: () => { throw new Error("no dir"); },
    })).toBeNull();
  });

  test("setSessionEnv resolves pass-backed values and surfaces command failures", async () => {
    reset();
    const envCalls: Array<[string, string, string]> = [];
    const okSpawn = () => ({
      stdout: new Response("secret-value\n").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
    });

    await wakeResolve.setSessionEnv("sess", {
      getEnvVars: () => ({ TOKEN: "pass:path/to/token", PLAIN: "value" }),
      spawn: okSpawn as any,
      setEnvironment: async (sessionName, key, value) => { envCalls.push([sessionName, key, value]); },
    });

    expect(envCalls).toEqual([
      ["sess", "TOKEN", "secret-value"],
      ["sess", "PLAIN", "value"],
    ]);

    await expect(wakeResolve.setSessionEnv("sess", {
      getEnvVars: () => ({ TOKEN: "pass:missing" }),
      spawn: (() => ({ stdout: new Response("").body!, stderr: new Response("nope").body!, exited: Promise.resolve(2) })) as any,
      setEnvironment: async () => {},
    })).rejects.toThrow("pass show 'missing' failed (exit 2)");
  });

  test("sanitizeBranchName trims unsafe boundary characters without over-stripping", () => {
    reset();
    expect(wakeResolve.sanitizeBranchName(" --My Task..Name!! ")).toBe("my-task.name");
    expect(wakeResolve.sanitizeBranchName("---")).toBe("");
    expect(wakeResolve.sanitizeBranchName("A".repeat(60))).toHaveLength(50);
  });
});


describe("coverage next wake command helpers", () => {
  test("worktree picker handles non-interactive, invalid, and selected choices", () => {
    reset();
    const originalTTY = wakeCmd._wtPicker.isStdoutTTY;
    const originalRead = wakeCmd._wtPicker.readChoice;
    const originalLog = console.log;
    const originalWrite = process.stdout.write;
    const candidates = [
      { name: "one", path: "/tmp/one" },
      { name: "two", path: "/tmp/two" },
    ];
    try {
      console.log = () => {};
      process.stdout.write = (() => true) as typeof process.stdout.write;
      wakeCmd._wtPicker.isStdoutTTY = () => false;
      expect(wakeCmd.promptAmbiguousWorktreePick("task", candidates)).toBeNull();

      wakeCmd._wtPicker.isStdoutTTY = () => true;
      wakeCmd._wtPicker.readChoice = () => "nope";
      expect(wakeCmd.promptAmbiguousWorktreePick("task", candidates)).toBeNull();

      wakeCmd._wtPicker.readChoice = () => "2";
      expect(wakeCmd.promptAmbiguousWorktreePick("task", candidates)).toEqual(candidates[1]);
    } finally {
      wakeCmd._wtPicker.isStdoutTTY = originalTTY;
      wakeCmd._wtPicker.readChoice = originalRead;
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  });

  test("live tile roles trim blank lines and tolerate tmux failures", async () => {
    reset();
    await expect(wakeCmd.getLiveTileRoles("sess", {
      hostExecFn: async () => "tile-a\n\n tile-b \n",
    })).resolves.toEqual(new Set(["tile-a", "tile-b"]));

    await expect(wakeCmd.getLiveTileRoles("sess", {
      hostExecFn: async () => { throw new Error("no tmux"); },
    })).resolves.toEqual(new Set());
  });
});
