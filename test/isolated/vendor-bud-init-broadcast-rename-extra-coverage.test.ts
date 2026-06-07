import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const srcRoot = join(root, "src");

let config: Record<string, any> = { githubOrg: "TestOrg" };
let ghqRoot = "/ghq";
let parseWakeTargetResult: any = null;
let ensureClonedCalls: string[] = [];
let normalizedTarget = "sprout";
let validateOracleError: Error | null = null;
let hostExecResult = "/ghq/github.com/TestOrg/parent-oracle";
let hostExecError: Error | null = null;
let hostExecCalls: string[] = [];
let resolveOrgResult: any = { org: "TestOrg", source: "flag" };
let ensureBudRepoResult = "/tmp/sprout-oracle";
let ensureBudRepoCalls: any[] = [];
let initVaultResult = "/tmp/sprout-oracle/ψ";
let initVaultCalls: string[] = [];
let generateClaudeMdCalls: any[] = [];
let configureFleetResult = "/fleet/01-sprout.json";
let configureFleetCalls: any[] = [];
let writeBirthNoteCalls: any[] = [];
let finalizeBudCalls: any[] = [];
let writeSignalCalls: any[] = [];
let validateNicknameResult: any = { ok: true, value: "Sprout Nick" };
let validateNicknameCalls: string[] = [];
let writeNicknameCalls: any[] = [];
let setCachedNicknameCalls: any[] = [];

let tmuxCurrentWindow = " current-oracle ";
let tmuxDisplayError: Error | null = null;
let tmuxCommandByTarget: Record<string, string> = {};
let tmuxCommandErrorTargets = new Set<string>();
let tmuxSessions: any[] = [];
let tmuxRunCalls: any[][] = [];
let tmuxSendCalls: any[] = [];

let spawnResponses: Array<{ status: number; stdout?: string; stderr?: string }> = [];
let spawnCalls: any[][] = [];

let archiveCalls: any[] = [];
let archiveError: Error | null = null;

let logs: string[] = [];
let errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => parseWakeTargetResult,
  ensureCloned: async (slug: string) => {
    ensureClonedCalls.push(slug);
  },
}));

mock.module("maw-js/core/matcher/normalize-target", () => ({
  normalizeTarget: (_target: string) => normalizedTarget,
}));

mock.module("maw-js/core/fleet/validate", () => ({
  assertValidOracleName: () => {
    if (validateOracleError) throw validateOracleError;
  },
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecError) throw hostExecError;
    return hostExecResult;
  },
  tmux: {
    run: async (...args: string[]) => {
      tmuxRunCalls.push(args);
      if (args[0] === "display-message" && args[1] === "-p" && args[2] === "#{window_name}") {
        if (tmuxDisplayError) throw tmuxDisplayError;
        return tmuxCurrentWindow;
      }
      const targetFlag = args.indexOf("-t");
      const target = targetFlag >= 0 ? args[targetFlag + 1] : "";
      if (tmuxCommandErrorTargets.has(target)) throw new Error(`tmux failed for ${target}`);
      return tmuxCommandByTarget[target] ?? "zsh";
    },
    listAll: async () => tmuxSessions,
    sendText: async (target: string, message: string) => {
      tmuxSendCalls.push({ target, message });
    },
  },
}));

mock.module(join(srcRoot, "vendor/mpr-plugins/bud/smart-default-org"), () => ({
  resolveOrg: async () => resolveOrgResult,
  formatOrgSource: (resolution: any) => `source:${resolution.source}`,
}));

mock.module(join(srcRoot, "vendor/mpr-plugins/bud/bud-repo"), () => ({
  ensureBudRepo: async (...args: any[]) => {
    ensureBudRepoCalls.push(args);
    return ensureBudRepoResult;
  },
}));

mock.module(join(srcRoot, "vendor/mpr-plugins/bud/bud-init"), () => ({
  initVault: (repoPath: string) => {
    initVaultCalls.push(repoPath);
    return initVaultResult;
  },
  generateClaudeMd: (...args: any[]) => {
    generateClaudeMdCalls.push(args);
  },
  configureFleet: (...args: any[]) => {
    configureFleetCalls.push(args);
    return configureFleetResult;
  },
  writeBirthNote: (...args: any[]) => {
    writeBirthNoteCalls.push(args);
  },
}));

mock.module(join(srcRoot, "vendor/mpr-plugins/bud/bud-wake"), () => ({
  finalizeBud: async (input: any) => {
    finalizeBudCalls.push(input);
  },
}));

mock.module("maw-js/core/fleet/leaf", () => ({
  writeSignal: (...args: any[]) => {
    writeSignalCalls.push(args);
  },
}));

mock.module("maw-js/core/fleet/nicknames", () => ({
  validateNickname: (value: string) => {
    validateNicknameCalls.push(value);
    return validateNicknameResult;
  },
  writeNickname: (...args: any[]) => {
    writeNicknameCalls.push(args);
  },
  setCachedNickname: (...args: any[]) => {
    setCachedNicknameCalls.push(args);
  },
}));

mock.module("node:child_process", () => ({
  spawnSync: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    return spawnResponses.shift() ?? { status: 0, stdout: "", stderr: "" };
  },
}));

function archiveImplMock() {
  return {
    cmdArchive: async (...args: any[]) => {
      archiveCalls.push(args);
      console.log(`archiving ${args[0]}`);
      if (archiveError) throw archiveError;
    },
  };
}

mock.module(join(srcRoot, "vendor/mpr-plugins/archive/impl"), archiveImplMock);
mock.module(join(srcRoot, "vendor/mpr-plugins/archive/impl.ts"), archiveImplMock);

const { cmdBud } = await import("../../src/vendor/mpr-plugins/bud/impl.ts?vendor-extra-coverage");
const { buildConfig, backupConfig, configExists, writeConfigAtomic } = await import("../../src/vendor/mpr-plugins/init/write-config.ts?vendor-extra-coverage");
const { cmdBroadcast } = await import("../../src/vendor/mpr-plugins/broadcast/impl.ts?vendor-extra-coverage");
const { autoPrefix, cmdRename } = await import("../../src/vendor/mpr-plugins/rename/src/impl.ts?vendor-extra-coverage");
const archivePlugin = await import("../../src/vendor/mpr-plugins/archive/index.ts?vendor-extra-coverage");
const archiveHandler = archivePlugin.default;

function resetConsoleCapture() {
  logs = [];
  errors = [];
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
}

function output() {
  return [...logs, ...errors].join("\n");
}

beforeEach(() => {
  config = { githubOrg: "TestOrg" };
  ghqRoot = "/ghq";
  parseWakeTargetResult = null;
  ensureClonedCalls = [];
  normalizedTarget = "sprout";
  validateOracleError = null;
  hostExecResult = "/ghq/github.com/TestOrg/parent-oracle";
  hostExecError = null;
  hostExecCalls = [];
  resolveOrgResult = { org: "TestOrg", source: "flag" };
  ensureBudRepoResult = "/tmp/sprout-oracle";
  ensureBudRepoCalls = [];
  initVaultResult = "/tmp/sprout-oracle/ψ";
  initVaultCalls = [];
  generateClaudeMdCalls = [];
  configureFleetResult = "/fleet/01-sprout.json";
  configureFleetCalls = [];
  writeBirthNoteCalls = [];
  finalizeBudCalls = [];
  writeSignalCalls = [];
  validateNicknameResult = { ok: true, value: "Sprout Nick" };
  validateNicknameCalls = [];
  writeNicknameCalls = [];
  setCachedNicknameCalls = [];

  tmuxCurrentWindow = " current-oracle ";
  tmuxDisplayError = null;
  tmuxCommandByTarget = {};
  tmuxCommandErrorTargets = new Set();
  tmuxSessions = [];
  tmuxRunCalls = [];
  tmuxSendCalls = [];

  spawnResponses = [];
  spawnCalls = [];
  archiveCalls = [];
  archiveError = null;
  resetConsoleCapture();
});

afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("bud impl extra isolated coverage", () => {
  test("rejects invalid stems and reserved -oracle suffix before side effects", async () => {
    normalizedTarget = "bad_name";
    await expect(cmdBud("bad_name", { root: true })).rejects.toThrow("invalid oracle name");

    normalizedTarget = "sprout-oracle";
    await expect(cmdBud("sprout-oracle", { root: true })).rejects.toThrow("must NOT end with '-oracle'");

    expect(ensureBudRepoCalls).toEqual([]);
    expect(finalizeBudCalls).toEqual([]);
  });

  test("validates nickname before repo work and surfaces fleet validator errors", async () => {
    validateNicknameResult = { ok: false, error: "nickname too long" };
    await expect(cmdBud("sprout", { root: true, nickname: "x" })).rejects.toThrow("nickname too long");
    expect(validateNicknameCalls).toEqual(["x"]);
    expect(ensureBudRepoCalls).toEqual([]);

    validateNicknameResult = { ok: true, value: "x" };
    validateOracleError = new Error("reserved view suffix");
    await expect(cmdBud("sprout", { root: true, nickname: "x" })).rejects.toThrow("reserved view suffix");
    expect(ensureBudRepoCalls).toEqual([]);
  });

  test("normal bud writes nickname, finalizes, drops parent signal, and reports default org override hint", async () => {
    resolveOrgResult = { org: "FleetOrg", source: "fleet" };
    await cmdBud("sprout", { from: "parent", nickname: "Sprout Nick", note: "hello", signalOnBirth: true, seed: true, issue: 7, repo: "owner/repo", split: true });

    expect(ensureBudRepoCalls[0]).toEqual(["FleetOrg/sprout-oracle", "/ghq/github.com/FleetOrg/sprout-oracle", "sprout-oracle", "FleetOrg"]);
    expect(initVaultCalls).toEqual(["/tmp/sprout-oracle"]);
    expect(generateClaudeMdCalls).toEqual([["/tmp/sprout-oracle", "sprout", "parent"]]);
    expect(writeNicknameCalls).toEqual([["/tmp/sprout-oracle", "Sprout Nick"]]);
    expect(setCachedNicknameCalls).toEqual([["sprout", "Sprout Nick"]]);
    expect(configureFleetCalls).toEqual([["sprout", "FleetOrg", "sprout-oracle", "parent"]]);
    expect(writeBirthNoteCalls).toEqual([["/tmp/sprout-oracle/ψ", "sprout", "parent", "hello"]]);
    expect(finalizeBudCalls[0]).toMatchObject({
      name: "sprout",
      parentName: "parent",
      org: "FleetOrg",
      budRepoName: "sprout-oracle",
      opts: { seed: true, issue: 7, repo: "owner/repo", split: true },
    });
    expect(writeSignalCalls[0][0]).toBe("/ghq/github.com/FleetOrg/parent-oracle");
    expect(writeSignalCalls[0][1]).toBe("sprout");
    expect(output()).toContain("override: --org <name> or MAW_BUD_OWNER=<name>");
  });

  test("parent URL is parsed, cloned when repo seed is absent, and clone is skipped when repo seed is explicit", async () => {
    parseWakeTargetResult = { oracle: "repo-parent", slug: "Owner/repo-parent-oracle" };
    await cmdBud("sprout", { from: "https://github.com/Owner/repo-parent-oracle" });
    expect(ensureClonedCalls).toEqual(["Owner/repo-parent-oracle"]);
    expect(finalizeBudCalls.at(-1).parentName).toBe("repo-parent");

    ensureClonedCalls = [];
    await cmdBud("sprout", { from: "Owner/repo-parent-oracle", repo: "seed/psi" });
    expect(ensureClonedCalls).toEqual([]);
  });

  test("parent autodetect derives the oracle stem from nested agents worktree paths", async () => {
    hostExecResult = "/ghq/github.com/TestOrg/parent-oracle/agents/feature-work";

    await cmdBud("sprout", { dryRun: true });

    expect(hostExecCalls).toEqual(["tmux display-message -p '#{pane_current_path}'"]);
    expect(output()).toContain("parent → sprout");
    expect(output()).toContain("born blank — pull memory later: maw soul-sync parent --from");
    expect(ensureBudRepoCalls).toEqual([]);
  });

  test("parent autodetect failure asks for --from or --root before repo creation", async () => {
    hostExecError = new Error("not in tmux");
    await expect(cmdBud("sprout", {})).rejects.toThrow("could not detect parent oracle");
    expect(hostExecCalls).toEqual(["tmux display-message -p '#{pane_current_path}'"]);
    expect(ensureBudRepoCalls).toEqual([]);
  });

  test("dry-run root bud reports nickname, root seed fallback, scaffold-only, and skipped wake", async () => {
    await cmdBud("sprout", {
      root: true,
      dryRun: true,
      nickname: "Sprout Nick",
      seed: true,
      scaffoldOnly: true,
    });

    expect(ensureBudRepoCalls).toEqual([]);
    expect(finalizeBudCalls).toEqual([]);
    const text = output();
    expect(text).toContain("[dry-run] would write nickname: Sprout Nick");
    expect(text).toContain("[dry-run] root oracle — no parent");
    expect(text).toContain("[dry-run] scaffold-only: would stop before git commit/push, wake, attach, parent sync_peers, and /awaken");
    expect(text).not.toContain("[dry-run] would wake sprout");
  });
});

describe("init write-config extra isolated coverage", () => {
  test("buildConfig writes local host defaults, optional token/ghqRoot, and federation peers only when enabled", () => {
    expect(buildConfig({ node: "white" })).toEqual({
      host: "local",
      node: "white",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude --dangerously-skip-permissions --continue" },
      sessions: {},
    });

    expect(buildConfig({ node: "mba", ghqRoot: "/ghq", token: "tok", federate: true, peers: [{ name: "white", url: "http://white:3456" }], federationToken: "fed" })).toMatchObject({
      host: "local",
      node: "mba",
      ghqRoot: "/ghq",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      federationToken: "fed",
      namedPeers: [{ name: "white", url: "http://white:3456" }],
    });

    expect(buildConfig({ node: "mba", federationToken: "ignored", peers: [{ name: "x", url: "y" }] } as any)).not.toHaveProperty("namedPeers");
  });

  test("writeConfigAtomic creates parent dirs, respects wx refusal, backupConfig copies timestamped config, and configExists reflects disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-write-config-"));
    try {
      const file = join(dir, "nested", "maw.config.json");
      expect(configExists(file)).toBe(false);

      writeConfigAtomic(file, { node: "white" } as any, false);
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ node: "white" });
      expect(configExists(file)).toBe(true);

      expect(() => writeConfigAtomic(file, { node: "mba" } as any, false)).toThrow();
      writeConfigAtomic(file, { node: "mba" } as any, true);
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ node: "mba" });

      const backupPath = backupConfig(file);
      expect(backupPath).toContain("maw.config.json.bak.");
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath, "utf-8")).toBe(readFileSync(file, "utf-8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("broadcast impl extra isolated coverage", () => {
  test("requires a message before tmux access", async () => {
    await expect(cmdBroadcast("")).rejects.toThrow("usage: maw broadcast <message>");
    expect(tmuxRunCalls).toEqual([]);
    expect(tmuxSendCalls).toEqual([]);
  });

  test("prefixes sender, skips overview scratch and -view sessions, skips non-claude panes, and counts tmux failures", async () => {
    tmuxSessions = [
      { name: "99-overview", windows: [{ index: 1, name: "ignored" }] },
      { name: "scratch", windows: [{ index: 1, name: "ignored" }] },
      { name: "neo-view", windows: [{ index: 1, name: "ignored" }] },
      { name: "01-neo", windows: [{ index: 1, name: "chat" }, { index: 2, name: "shell" }, { index: 3, name: "broken" }] },
    ];
    tmuxCommandByTarget = { "01-neo:1": "claude", "01-neo:2": "zsh" };
    tmuxCommandErrorTargets = new Set(["01-neo:3"]);

    await cmdBroadcast("hello fleet");

    expect(tmuxSendCalls).toEqual([{ target: "01-neo:1", message: "[broadcast from current-oracle] hello fleet" }]);
    expect(output()).toContain("→ 01-neo:chat");
    expect(output()).toContain("Broadcast to 1 windows (2 skipped)");
  });

  test("falls back to unknown sender when current window cannot be detected", async () => {
    tmuxDisplayError = new Error("outside tmux");
    tmuxSessions = [{ name: "01-neo", windows: [{ index: 1, name: "chat" }] }];
    tmuxCommandByTarget = { "01-neo:1": "claude" };

    await cmdBroadcast("ping");

    expect(tmuxSendCalls[0]).toEqual({ target: "01-neo:1", message: "[broadcast from unknown] ping" });
  });
});

describe("rename impl extra isolated coverage", () => {
  test("autoPrefix strips numeric session prefix and avoids double prefixing", () => {
    expect(autoPrefix("03-neo", "work")).toBe("neo-work");
    expect(autoPrefix("neo", "neo-work")).toBe("neo-work");
  });

  test("renames a tab by number and by exact name", async () => {
    spawnResponses = [
      { status: 0, stdout: "03-neo\n" },
      { status: 0, stdout: "1:neo-chat\n2:neo-shell\n" },
      { status: 0, stdout: "" },
    ];
    await cmdRename("2", "work");
    expect(spawnCalls.at(-1)).toEqual(["rename-window", "-t", "03-neo:2", "neo-work"]);
    expect(output()).toContain("tab 2");

    spawnResponses = [
      { status: 0, stdout: "neo\n" },
      { status: 0, stdout: "1:neo-chat\n2:neo-shell\n" },
      { status: 0, stdout: "" },
    ];
    await cmdRename("neo-chat", "neo-focus");
    expect(spawnCalls.at(-1)).toEqual(["rename-window", "-t", "neo:1", "neo-focus"]);
  });

  test("reports available tabs when the target is missing and surfaces tmux stderr on failures", async () => {
    spawnResponses = [
      { status: 0, stdout: "03-neo\n" },
      { status: 0, stdout: "1:neo-chat\n" },
    ];
    await expect(cmdRename("missing", "work")).rejects.toThrow("tab missing not found in 03-neo");
    expect(output()).toContain("tabs: 1:neo-chat");

    spawnResponses = [{ status: 1, stderr: "no server running" }];
    await expect(cmdRename("1", "work")).rejects.toThrow("no server running");
  });

  test("empty tmux window lists produce an explicit not-found error", async () => {
    spawnResponses = [
      { status: 0, stdout: "neo\n" },
      { status: 0, stdout: "" },
    ];
    await expect(cmdRename("1", "work")).rejects.toThrow("tab 1 not found in neo");
    expect(output()).toContain("tabs:");
  });
});

describe("archive index extra isolated coverage", () => {
  test("prints help through writer without calling archive impl", async () => {
    const written: string[] = [];
    await expect(archiveHandler({ source: "cli", args: ["--help"], writer: (msg: string) => written.push(msg) } as any)).resolves.toEqual({ ok: true });
    expect(written.join("\n")).toContain("usage: maw archive <oracle>");
    expect(archiveCalls).toEqual([]);
  });

  test("requires an oracle argument, maps --dry-run, captures writer output, and restores console", async () => {
    await expect(archiveHandler({ source: "cli", args: [] } as any)).resolves.toEqual({ ok: false, error: "usage: maw archive <oracle> [--dry-run]", output: undefined });

    const capturedLog = console.log;
    const written: string[] = [];
    const result = await archiveHandler({ source: "cli", args: ["neo", "--dry-run"], writer: (...msg: any[]) => written.push(msg.map(String).join(" ")) } as any);
    expect(result).toEqual({ ok: true, output: undefined });
    expect(archiveCalls).toEqual([["neo", { dryRun: true }]]);
    expect(written.join("\n")).toContain("archiving neo");
    expect(console.log).toBe(capturedLog);
  });

  test("captures archive console output in cli results and prefers logs over thrown error text", async () => {
    const ok = await archiveHandler({ source: "cli", args: ["neo"] } as any);
    expect(ok).toEqual({ ok: true, output: "archiving neo" });

    archiveError = new Error("boom");
    const failed = await archiveHandler({ source: "cli", args: ["neo"] } as any);
    expect(failed).toEqual({ ok: false, error: "archiving neo", output: "archiving neo" });
  });
});
