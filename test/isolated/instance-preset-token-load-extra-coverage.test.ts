import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir as realHomedir } from "os";

const tokenLibPath = import.meta.resolve("../../src/vendor/mpr-plugins/token/lib");
const pluginsRegistryPath = import.meta.resolve("../../src/plugin/registry");
const pluginsLsInfoPath = import.meta.resolve("../../src/commands/shared/plugins-ls-info");
const pluginsInstallPath = import.meta.resolve("../../src/commands/shared/plugins-install");
const pluginsProfilePath = import.meta.resolve("../../src/commands/shared/plugins-profile");
const pluginsTogglePath = import.meta.resolve("../../src/commands/shared/plugins-toggle");
const pluginsUiPath = import.meta.resolve("../../src/commands/shared/plugins-ui");

type RunCall = { cmd: string[]; opts?: Record<string, unknown> };

type PluginCall = { fn: string; args: unknown[] };

let passExistsResult = true;
let confirmResult = true;
let defaultNameResult: string | null = null;
let runResults: Array<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> = [];
let passExistsCalls: string[] = [];
let confirmCalls: string[] = [];
let defaultNameCalls: Array<[string | undefined, string]> = [];
let runCalls: RunCall[] = [];
let pluginCalls: PluginCall[] = [];
let registryDiscoverResult: unknown[] = [];
let mockedHome = "";

mock.module("os", () => ({
  homedir: () => mockedHome || realHomedir(),
}));

mock.module(tokenLibPath, () => ({
  PASS_PREFIX: "envrc",
  defaultName: (name: string | undefined, cwd: string) => {
    defaultNameCalls.push([name, cwd]);
    if (defaultNameResult) return defaultNameResult;
    return name ?? cwd.replace(/\/+$/, "").split("/").pop() ?? "default";
  },
  passExists: (path: string) => {
    passExistsCalls.push(path);
    return passExistsResult;
  },
  confirm: async (message: string) => {
    confirmCalls.push(message);
    return confirmResult;
  },
  run: (cmd: string[], opts?: Record<string, unknown>) => {
    runCalls.push({ cmd, opts });
    return runResults.shift() ?? { ok: true, exitCode: 0, stdout: "SECRET=loaded\n", stderr: "" };
  },
}));

mock.module(pluginsRegistryPath, () => ({
  discoverPackages: () => registryDiscoverResult,
}));

mock.module(pluginsLsInfoPath, () => ({
  doLs: (...args: unknown[]) => pluginCalls.push({ fn: "doLs", args }),
  doInfo: (...args: unknown[]) => pluginCalls.push({ fn: "doInfo", args }),
}));

mock.module(pluginsInstallPath, () => ({
  doInstall: (...args: unknown[]) => pluginCalls.push({ fn: "doInstall", args }),
  doRemove: (...args: unknown[]) => pluginCalls.push({ fn: "doRemove", args }),
}));

mock.module(pluginsProfilePath, () => ({
  doProfile: (...args: unknown[]) => pluginCalls.push({ fn: "doProfile", args }),
  doNuke: (...args: unknown[]) => pluginCalls.push({ fn: "doNuke", args }),
}));

mock.module(pluginsTogglePath, () => ({
  doEnable: (...args: unknown[]) => pluginCalls.push({ fn: "doEnable", args }),
  doDisable: (...args: unknown[]) => pluginCalls.push({ fn: "doDisable", args }),
}));

mock.module(pluginsUiPath, () => ({
  archiveToTmp: () => undefined,
  surfaces: () => "",
  shortenHome: (value: string) => value,
  printTable: () => undefined,
}));

const { applyInstancePreset } = await import("../../src/cli/instance-preset.ts?instance-preset-extra-coverage");
const { cmdLoad } = await import("../../src/vendor/mpr-plugins/token/load.ts?token-load-extra-coverage");
const { cmdPlugins } = await import("../../src/commands/shared/plugins.ts?plugins-extra-coverage");

let tempRoots: string[] = [];
let originalHome: string | undefined;
let originalMawHome: string | undefined;
let errorSpy: ReturnType<typeof spyOn> | null = null;
let exitSpy: ReturnType<typeof spyOn> | null = null;
let exitCodes: number[] = [];

function makeTempRoot(prefix: string): string {
  const dir = `/tmp/${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  tempRoots.push(dir);
  return dir;
}

function stubExit() {
  exitCodes = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error(`process.exit(${code ?? 0})`);
  });
}

beforeEach(() => {
  passExistsResult = true;
  confirmResult = true;
  defaultNameResult = null;
  runResults = [];
  passExistsCalls = [];
  confirmCalls = [];
  defaultNameCalls = [];
  runCalls = [];
  pluginCalls = [];
  registryDiscoverResult = [];
  mockedHome = "";
  originalHome = process.env.HOME;
  originalMawHome = process.env.MAW_HOME;
  errorSpy = null;
  exitSpy = null;
  exitCodes = [];
  tempRoots = [];
});

afterEach(() => {
  if (exitSpy) exitSpy.mockRestore();
  if (errorSpy) errorSpy.mockRestore();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

describe("applyInstancePreset isolated branches", () => {
  test("ignores missing --as and non-serve invocations without touching MAW_HOME", () => {
    delete process.env.MAW_HOME;

    applyInstancePreset(["serve", "5001"]);
    applyInstancePreset(["wake", "target", "--as", "dev"]);

    expect(process.env.MAW_HOME).toBeUndefined();
  });

  test("sets MAW_HOME under the selected temp home and creates the shared plugin symlink", () => {
    const home = makeTempRoot("maw-instance-home");
    mockedHome = home;
    process.env.HOME = home;
    delete process.env.MAW_HOME;
    mkdirSync(join(home, ".maw", "plugins"), { recursive: true });

    applyInstancePreset(["serve", "5001", "--as", "dev_1"]);

    const instanceHome = join(home, ".maw", "inst", "dev_1");
    expect(process.env.MAW_HOME).toBe(instanceHome);
    expect(existsSync(instanceHome)).toBe(true);
    expect(existsSync(join(instanceHome, "plugins"))).toBe(true);
  });

  test("continues when plugin symlink creation fails", () => {
    const home = makeTempRoot("maw-instance-link-fail");
    mockedHome = home;
    process.env.HOME = home;
    const instanceHome = join(home, ".maw", "inst", "linked");
    mkdirSync(instanceHome, { recursive: true });
    writeFileSync(join(instanceHome, "plugins"), "already here");

    applyInstancePreset(["serve", "--as", "linked"]);

    expect(process.env.MAW_HOME).toBe(instanceHome);
    expect(readFileSync(join(instanceHome, "plugins"), "utf8")).toBe("already here");
  });

  test("exits with clear errors for missing or invalid instance names", () => {
    stubExit();

    expect(() => applyInstancePreset(["serve", "--as"])).toThrow("process.exit(1)");
    expect(() => applyInstancePreset(["serve", "--as", "BadName"])).toThrow("process.exit(1)");

    expect(exitCodes).toEqual([1, 1]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--as requires an instance name"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid instance name"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BadName"));
  });
});

describe("cmdLoad isolated branches", () => {
  test("returns a missing pass-vault error before reading or writing .envrc", async () => {
    const cwd = makeTempRoot("maw-token-load-missing");
    passExistsResult = false;

    const result = await cmdLoad({ name: "missing", cwd });

    expect(result).toEqual({ ok: false, error: "envrc/missing not found in pass" });
    expect(passExistsCalls).toEqual(["envrc/missing"]);
    expect(runCalls).toEqual([]);
    expect(existsSync(join(cwd, ".envrc"))).toBe(false);
  });

  test("skips overwrite when .envrc exists and confirmation is declined", async () => {
    const cwd = makeTempRoot("maw-token-load-skip");
    writeFileSync(join(cwd, ".envrc"), "EXISTING=1\n");
    confirmResult = false;

    const result = await cmdLoad({ cwd });

    expect(result).toEqual({ ok: true, skipped: true, path: `envrc/${cwd.split("/").pop()}` });
    expect(confirmCalls).toEqual(["Overwrite .envrc?"]);
    expect(runCalls).toEqual([]);
    expect(readFileSync(join(cwd, ".envrc"), "utf8")).toBe("EXISTING=1\n");
  });

  test("loads pass stdout to .envrc and reports direnv success", async () => {
    const cwd = makeTempRoot("maw-token-load-success");
    writeFileSync(join(cwd, ".envrc"), "OLD=1\n");
    runResults = [
      { ok: true, exitCode: 0, stdout: "SECRET=loaded\n", stderr: "" },
      { ok: true, exitCode: 0, stdout: "", stderr: "" },
    ];

    const result = await cmdLoad({ name: "demo", cwd, assumeYes: true });

    expect(result).toEqual({ ok: true, path: "envrc/demo", direnvOk: true });
    expect(confirmCalls).toEqual([]);
    expect(runCalls).toEqual([
      { cmd: ["pass", "show", "envrc/demo"], opts: undefined },
      { cmd: ["direnv", "allow", "."], opts: { cwd } },
    ]);
    expect(readFileSync(join(cwd, ".envrc"), "utf8")).toBe("SECRET=loaded\n");
  });

  test("surfaces pass show failures without writing secrets", async () => {
    const cwd = makeTempRoot("maw-token-load-pass-fail");
    runResults = [{ ok: false, exitCode: 7, stdout: "SECRET=should-not-write", stderr: "boom" }];

    const result = await cmdLoad({ name: "bad", cwd, skipDirenv: true });

    expect(result).toEqual({ ok: false, error: "pass show failed (exit 7)" });
    expect(existsSync(join(cwd, ".envrc"))).toBe(false);
  });

  test("supports force, skipDirenv, and false direnv results", async () => {
    const forceCwd = makeTempRoot("maw-token-load-force");
    writeFileSync(join(forceCwd, ".envrc"), "OLD=1\n");
    runResults = [{ ok: true, exitCode: 0, stdout: "FORCED=1\n", stderr: "" }];

    const skippedDirenv = await cmdLoad({ name: "forced", cwd: forceCwd, force: true, skipDirenv: true });

    expect(skippedDirenv).toEqual({ ok: true, path: "envrc/forced", direnvOk: true });
    expect(confirmCalls).toEqual([]);
    expect(runCalls).toEqual([{ cmd: ["pass", "show", "envrc/forced"], opts: undefined }]);
    expect(readFileSync(join(forceCwd, ".envrc"), "utf8")).toBe("FORCED=1\n");

    const direnvCwd = makeTempRoot("maw-token-load-direnv-fail");
    runCalls = [];
    runResults = [
      { ok: true, exitCode: 0, stdout: "TOKEN=1\n", stderr: "" },
      { ok: false, exitCode: 126, stdout: "", stderr: "direnv nope" },
    ];

    const failedDirenv = await cmdLoad({ name: "direnv-fails", cwd: direnvCwd });

    expect(failedDirenv).toEqual({ ok: true, path: "envrc/direnv-fails", direnvOk: false });
    expect(runCalls[1]).toEqual({ cmd: ["direnv", "allow", "."], opts: { cwd: direnvCwd } });
  });
});

describe("cmdPlugins isolated branch dispatcher", () => {
  test("routes list/default/profile/toggle/nuke branches to the expected helpers", async () => {
    const discover = () => [{ manifest: { name: "demo" }, dir: "/tmp/demo" }] as any[];

    await cmdPlugins("list", [], { _: [], "--json": true, "--all": true }, discover as any);
    await cmdPlugins("unknown", [], { _: [] }, discover as any);
    await cmdPlugins("lean", [], { _: [] }, discover as any);
    await cmdPlugins("standard", [], { _: [] }, discover as any);
    await cmdPlugins("full", [], { _: [] }, discover as any);
    await cmdPlugins("nuke", [], { _: [] }, discover as any);
    await cmdPlugins("enable", [], { _: ["alpha", "beta"] }, discover as any);
    await cmdPlugins("disable", [], { _: ["alpha"] }, discover as any);

    expect(pluginCalls.map(call => call.fn)).toEqual([
      "doLs",
      "doLs",
      "doProfile",
      "doProfile",
      "doProfile",
      "doNuke",
      "doEnable",
      "doDisable",
    ]);
    expect(pluginCalls[0].args).toEqual([true, true, discover, undefined, { verbose: false, tiers: [], apiOnly: false }]);
    expect(pluginCalls[1].args).toEqual([false, false, discover, undefined, { verbose: false, tiers: [], apiOnly: false }]);
    expect(pluginCalls[2].args).toEqual(["core", discover]);
    expect(pluginCalls[3].args).toEqual(["standard", discover]);
    expect(pluginCalls[4].args).toEqual(["full", discover]);
    expect(pluginCalls[6].args).toEqual([["alpha", "beta"]]);
    expect(pluginCalls[7].args).toEqual(["alpha"]);
  });

  test("routes install/remove aliases and force flag", async () => {
    const discover = () => [] as any[];

    await cmdPlugins("install", [], { _: ["/tmp/plugin"], "--force": true }, discover as any);
    await cmdPlugins("uninstall", [], { _: ["old-plugin"] }, discover as any);
    await cmdPlugins("rm", [], { _: ["older-plugin"] }, discover as any);

    expect(pluginCalls).toEqual([
      { fn: "doInstall", args: ["/tmp/plugin", true] },
      { fn: "doRemove", args: ["old-plugin", discover] },
      { fn: "doRemove", args: ["older-plugin", discover] },
    ]);
  });

  test("exits with usage for missing required plugin arguments", async () => {
    stubExit();

    for (const sub of ["info", "install", "remove", "enable", "disable"] as const) {
      await expect(cmdPlugins(sub, [], { _: [] })).rejects.toThrow("process.exit(1)");
    }

    expect(exitCodes).toEqual([1, 1, 1, 1, 1]);
    expect(errorSpy).toHaveBeenCalledWith("usage: maw plugins info <name>");
    expect(errorSpy).toHaveBeenCalledWith("usage: maw plugins install <path> [--force]");
    expect(errorSpy).toHaveBeenCalledWith("usage: maw plugins remove <name>");
    expect(errorSpy).toHaveBeenCalledWith("usage: maw plugin enable <name> [more...]");
    expect(errorSpy).toHaveBeenCalledWith("usage: maw plugin disable <name>");
  });
});
