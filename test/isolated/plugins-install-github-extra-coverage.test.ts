/**
 * Extra coverage for src/commands/shared/plugins-install.ts.
 *
 * This file intentionally tests the shared seam directly instead of the newer
 * plugin/install-impl path. It keeps all filesystem writes in temp directories
 * and mocks process.exit/Bun.spawn per test so failure branches stay hermetic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { doInstall, doRemove } from "../../src/commands/shared/plugins-install";
import type { LoadedPlugin, PluginManifest } from "../../src/plugin/types";

const createdDirs: string[] = [];
const archiveNames: string[] = [];
let originalPluginHome: string | undefined;
let originalSpawn: typeof Bun.spawn;

type CaptureResult = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
};

function tmpDir(prefix = "maw-shared-plugin-install-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function pluginHome(): string {
  return process.env.MAW_PLUGIN_HOME!;
}

function rememberArchive(name: string): string {
  archiveNames.push(name);
  return name;
}

function cleanupArchives(): void {
  const archiveRoot = "/tmp";
  for (const name of archiveNames.splice(0)) {
    const prefix = `maw-plugin-${name}-`;
    for (const entry of readdirSync(archiveRoot)) {
      if (entry.startsWith(prefix)) {
        rmSync(join(archiveRoot, entry), { recursive: true, force: true });
      }
    }
  }
}

function writePlugin(
  dir: string,
  manifest: Partial<PluginManifest> & { name: string; version?: string; sdk?: string },
  contents = "export default () => ({ ok: true });\n",
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), contents);
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        sdk: "*",
        entry: "index.js",
        target: "js",
        capabilities: [],
        ...manifest,
      },
      null,
      2,
    ) + "\n",
  );
}

function buildPlugin(name: string, version = "1.0.0", contents?: string): string {
  const dir = tmpDir(`${name}-src-`);
  writePlugin(dir, { name, version }, contents);
  return dir;
}

function plantInstalledPlugin(name: string, marker = "old\n"): string {
  const dir = join(pluginHome(), name);
  writePlugin(dir, { name }, marker);
  return dir;
}

async function capture(fn: () => unknown | Promise<unknown>): Promise<CaptureResult> {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const outs: string[] = [];
  const errs: string[] = [];
  let exitCode: number | undefined;

  console.log = (...args: unknown[]) => outs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__maw_test_exit__:${exitCode}`);
  };

  try {
    await fn();
  } catch (err: any) {
    if (!String(err?.message ?? "").startsWith("__maw_test_exit__")) throw err;
  } finally {
    (process as any).exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }

  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n") };
}

function mockSpawn(
  handler: (args: string[], opts: unknown) => { code: number; stdout?: string },
): string[][] {
  const calls: string[][] = [];
  (Bun as any).spawn = (args: string[], opts: unknown) => {
    calls.push([...args]);
    const result = handler(args, opts);
    return {
      exited: Promise.resolve(result.code),
      stdout: result.stdout ?? "",
      stderr: "",
    };
  };
  return calls;
}

function loadedPlugin(name: string, dir: string): LoadedPlugin {
  return {
    manifest: { name, version: "1.0.0", sdk: "*" },
    dir,
    wasmPath: "",
    entryPath: join(dir, "index.js"),
    kind: "ts",
  };
}

beforeEach(() => {
  originalPluginHome = process.env.MAW_PLUGIN_HOME;
  originalSpawn = Bun.spawn;
  process.env.MAW_PLUGIN_HOME = join(tmpDir("maw-plugin-home-"), "plugins");
});

afterEach(() => {
  process.env.MAW_PLUGIN_HOME = originalPluginHome ?? "";
  if (originalPluginHome === undefined) delete process.env.MAW_PLUGIN_HOME;
  (Bun as any).spawn = originalSpawn;
  cleanupArchives();
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("doInstall local source", () => {
  test("copies a local plugin into MAW_PLUGIN_HOME", async () => {
    const src = buildPlugin("local-extra", "1.2.3", "export const marker = 'new';\n");

    const result = await capture(() => doInstall(src, false));

    const dest = join(pluginHome(), "local-extra");
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("installed local-extra@1.2.3");
    expect(existsSync(join(dest, "plugin.json"))).toBe(true);
    expect(readFileSync(join(dest, "index.js"), "utf8")).toContain("marker");
  });

  test("exits when the local source path is missing", async () => {
    const missing = join(tmpDir("missing-parent-"), "does-not-exist");

    const result = await capture(() => doInstall(missing, false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`path not found: ${resolve(missing)}`);
  });

  test("exits when plugin.json is absent", async () => {
    const src = tmpDir("no-manifest-branch-");
    writeFileSync(join(src, "index.js"), "export default {};\n");

    const result = await capture(() => doInstall(src, false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`no plugin.json in: ${resolve(src)}`);
  });

  test("exits when plugin.json is invalid", async () => {
    const src = tmpDir("invalid-manifest-branch-");
    writeFileSync(join(src, "plugin.json"), JSON.stringify({ name: "Bad Name", sdk: "*", version: "1.0.0" }));

    const result = await capture(() => doInstall(src, false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid plugin: plugin.json: name must match");
  });

  test("refuses to overwrite an existing install without --force", async () => {
    plantInstalledPlugin("local-refuse", "old install\n");
    const src = buildPlugin("local-refuse", "2.0.0", "new install\n");

    const result = await capture(() => doInstall(src, false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("plugin 'local-refuse' already installed");
    expect(readFileSync(join(pluginHome(), "local-refuse", "index.js"), "utf8")).toContain("old install");
  });

  test("archives an existing install before a forced overwrite", async () => {
    rememberArchive("local-force");
    plantInstalledPlugin("local-force", "old install\n");
    const src = buildPlugin("local-force", "2.0.0", "new install\n");

    const result = await capture(() => doInstall(src, true));

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("installed local-force@2.0.0");
    expect(readFileSync(join(pluginHome(), "local-force", "index.js"), "utf8")).toContain("new install");
    expect(
      readdirSync("/tmp").some(entry => entry.startsWith("maw-plugin-local-force-")),
    ).toBe(true);
  });
});

describe("doRemove", () => {
  test("archives a discovered plugin", async () => {
    const name = rememberArchive("remove-me");
    const dir = plantInstalledPlugin(name, "installed\n");

    const result = await capture(() => doRemove(name, () => [loadedPlugin(name, dir)]));

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("removed remove-me");
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync("/tmp").some(entry => entry.startsWith("maw-plugin-remove-me-"))).toBe(true);
  });

  test("exits when the named plugin is not discovered", async () => {
    const result = await capture(() => doRemove("missing-plugin", () => []));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("plugin not found: missing-plugin");
  });
});

describe("doInstall GitHub sources", () => {
  test("normalizes, clones, resolves ghq root, and installs a GitHub repo", async () => {
    const ghqRoot = tmpDir("ghq-root-");
    const repoDir = join(ghqRoot, "github.com", "org", "repo");
    writePlugin(repoDir, { name: "github-extra", version: "3.0.0" }, "github clone install\n");
    const calls = mockSpawn(args => {
      if (args[0] === "ghq" && args[1] === "get") return { code: 0 };
      if (args[0] === "ghq" && args[1] === "root") return { code: 0, stdout: ghqRoot };
      throw new Error(`unexpected spawn: ${args.join(" ")}`);
    });

    const result = await capture(() => doInstall("https://github.com/org/repo.git", false));

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("cloning https://github.com/org/repo.git");
    expect(result.stdout).toContain("installed github-extra@3.0.0");
    expect(existsSync(join(pluginHome(), "github-extra", "plugin.json"))).toBe(true);
    expect(calls).toEqual([
      ["ghq", "get", "-u", "https://github.com/org/repo.git"],
      ["ghq", "root"],
    ]);
  });

  test("lists monorepo package plugins and returns without installing", async () => {
    const ghqRoot = tmpDir("ghq-mono-root-");
    const repoDir = join(ghqRoot, "github.com", "org", "mono");
    const pkgDir = join(repoDir, "packages");
    writePlugin(join(pkgDir, "good"), { name: "good-plugin", version: "4.5.6" });
    mkdirSync(join(pkgDir, "bad"), { recursive: true });
    writeFileSync(join(pkgDir, "bad", "plugin.json"), "{not-json");
    mockSpawn(args => {
      if (args[1] === "get") return { code: 0 };
      if (args[1] === "root") return { code: 0, stdout: `${ghqRoot}\n` };
      throw new Error(`unexpected spawn: ${args.join(" ")}`);
    });

    const result = await capture(() => doInstall("github.com/org/mono", false));

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("cloning https://github.com/org/mono");
    expect(result.stdout).toContain("Found 2 plugins");
    expect(result.stdout).toContain("good-plugin v4.5.6");
    expect(result.stdout).toMatch(/\n\s+bad\n/);
    expect(result.stdout).toContain(`Install: maw plugin install ${pkgDir}/<name>`);
    expect(existsSync(join(pluginHome(), "good-plugin"))).toBe(false);
  });

  test("exits before cloning when an http-like URL has an invalid scheme", async () => {
    const calls = mockSpawn(() => {
      throw new Error("spawn should not be called for invalid schemes");
    });

    const result = await capture(() => doInstall("httpx://github.com/org/repo", false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid URL scheme: httpx://github.com/org/repo");
    expect(calls).toEqual([]);
  });

  test("exits when ghq clone fails", async () => {
    const calls = mockSpawn(args => {
      if (args[1] === "get") return { code: 9 };
      throw new Error(`unexpected spawn after failed clone: ${args.join(" ")}`);
    });

    const result = await capture(() => doInstall("https://github.com/org/fail.git", false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed to clone: https://github.com/org/fail.git");
    expect(calls).toEqual([["ghq", "get", "-u", "https://github.com/org/fail.git"]]);
  });

  test("exits when ghq reports success but the expected clone path is missing", async () => {
    const ghqRoot = tmpDir("ghq-empty-root-");
    mockSpawn(args => {
      if (args[1] === "get") return { code: 0 };
      if (args[1] === "root") return { code: 0, stdout: ghqRoot };
      throw new Error(`unexpected spawn: ${args.join(" ")}`);
    });

    const result = await capture(() => doInstall("https://github.com/org/missing.git", false));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`cloned but not found: ${join(ghqRoot, "github.com", "org", "missing")}`);
  });
});
