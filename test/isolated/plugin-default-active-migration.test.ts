/**
 * #1500 — old profile-generated disabledPlugins lists hid essential plugin
 * commands. The migration should heal only the legacy large-list shape, then
 * persist a marker so later manual disables still work.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1524_MIGRATION,
} from "../../src/plugin/default-active";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const homes: string[] = [];

function makeHome(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "maw-1500-"));
  homes.push(home);
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "maw.config.json"), JSON.stringify(config, null, 2) + "\n");
  return home;
}

function makePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-1500-plugins-"));
  homes.push(dir);
  return dir;
}

function loadInSubprocess(home: string) {
  return spawnSync("bun", ["-e", `
    const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
    const cfg = loadConfig();
    console.log(JSON.stringify({ disabledPlugins: cfg.disabledPlugins ?? [], migrations: cfg.migrations ?? {} }));
  `], {
    env: { ...process.env, MAW_HOME: home, MAW_TEST_MODE: "1" },
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function readConfig(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, "config", "maw.config.json"), "utf-8"));
}

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("#1500 default-active plugin migration", () => {
  test("large legacy disabled list re-enables default-active plugins and persists marker", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: [
        "team", "fleet", "panes", "peers", "pair", "tmux", "kill", "plugin", "doctor", "inbox",
        "costs", "learn", "archive", "broadcast", "demo", "find", "project", "scope", "tab", "trust",
        "workspace", "resume",
      ],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("config.disabledPlugins migration (#1500)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).not.toContain("team");
    expect(disk.disabledPlugins).not.toContain("fleet");
    expect(disk.disabledPlugins).not.toContain("pair");
    expect(disk.disabledPlugins).toContain("costs");
    expect(disk.disabledPlugins).toContain("learn");
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]).toBe(true);
  });

  test("small manual disable list is preserved", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: ["team"],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("config.disabledPlugins migration (#1500)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).toEqual(["team"]);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]).toBeUndefined();
  });

  test("#1514 re-enables split when #1500 already healed a stale profile list", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      migrations: { [DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]: true },
      disabledPlugins: [
        "split", "costs", "learn", "archive", "broadcast", "demo", "find",
        "project", "scope", "tab", "trust", "workspace", "resume",
      ],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("config.disabledPlugins migration (#1514)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).not.toContain("split");
    expect(disk.disabledPlugins).toContain("costs");
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]).toBe(true);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION]).toBe(true);
  });

  test("#1514 preserves a small manual split disable list", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: ["split"],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("config.disabledPlugins migration (#1514)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).toEqual(["split"]);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION]).toBeUndefined();
  });

  test("#1523 re-enables shellenv when earlier default-active migrations already healed a stale profile list", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      migrations: {
        [DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]: true,
        [DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION]: true,
      },
      disabledPlugins: ["shellenv", "costs"],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("config.disabledPlugins migration (#1523)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).not.toContain("shellenv");
    expect(disk.disabledPlugins).toContain("costs");
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]).toBe(true);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION]).toBe(true);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION]).toBe(true);
  });

  test("#1523 preserves a small manual shellenv disable list", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: ["shellenv"],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("config.disabledPlugins migration (#1523)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).toEqual(["shellenv"]);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION]).toBeUndefined();
  });

  test("#1524 re-enables completions when prior default-active migrations already healed a stale profile list", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      migrations: {
        [DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION]: true,
        [DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION]: true,
        [DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION]: true,
      },
      disabledPlugins: ["completions", "costs"],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("config.disabledPlugins migration (#1524)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).not.toContain("completions");
    expect(disk.disabledPlugins).toContain("costs");
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1524_MIGRATION]).toBe(true);
  });

  test("#1524 preserves a small manual completions disable list", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: ["completions"],
    });

    const result = loadInSubprocess(home);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("config.disabledPlugins migration (#1524)");

    const disk = readConfig(home);
    expect(disk.disabledPlugins).toEqual(["completions"]);
    expect(disk.migrations?.[DEFAULT_ACTIVE_PLUGINS_1524_MIGRATION]).toBeUndefined();
  });

  test("typing a disabled installed plugin explains the real fix", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: ["costs"],
    });
    const pluginDir = makePluginDir();

    const result = spawnSync("bun", ["src/cli.ts", "costs"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MAW_HOME: home,
        MAW_PLUGINS_DIR: pluginDir,
        MAW_TEST_MODE: "1",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'costs' is installed but disabled");
    expect(result.stderr).toContain("maw plugin enable costs");
  });

  test("typing disabled completions prints enable hint instead of self-suggesting", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
      disabledPlugins: ["completions"],
    });
    const pluginDir = makePluginDir();

    const result = spawnSync("bun", ["src/cli.ts", "--quiet", "completions"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MAW_HOME: home,
        MAW_PLUGINS_DIR: pluginDir,
        MAW_TEST_MODE: "1",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'completions' is installed but disabled");
    expect(result.stderr).toContain("maw plugin enable completions");
    expect(result.stderr).not.toContain("did you mean: completions");
  });

  test("completions plugin emits command list plus zsh/bash scripts", () => {
    const home = makeHome({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    });
    const pluginDir = makePluginDir();
    const env = {
      ...process.env,
      MAW_HOME: home,
      MAW_PLUGINS_DIR: pluginDir,
      MAW_TEST_MODE: "1",
      MAW_QUIET: "1",
    };

    const commands = spawnSync("bun", ["src/cli.ts", "--quiet", "completions", "commands"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(commands.status).toBe(0);
    expect(commands.stdout).toContain("completions");
    expect(commands.stdout).toContain("bring");
    expect(commands.stdout).toContain("plugin");

    const zsh = spawnSync("bun", ["src/cli.ts", "--quiet", "completions", "zsh"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(zsh.status).toBe(0);
    expect(zsh.stdout).toContain("#compdef maw");
    expect(zsh.stdout).toContain("maw completions windows");

    const bash = spawnSync("bun", ["src/cli.ts", "--quiet", "completions", "bash"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(bash.status).toBe(0);
    expect(bash.stdout).toContain("complete -F _maw_complete maw");
    expect(bash.stdout).toContain("maw completions commands");
  });
});
