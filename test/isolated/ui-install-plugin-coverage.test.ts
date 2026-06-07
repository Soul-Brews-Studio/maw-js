/** Targeted isolated coverage for src/vendor/mpr-plugins/ui/ui-install.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as realTmpdir } from "node:os";

const homeDir = mkdtempSync(join(realTmpdir(), "maw-ui-home-"));
const tempRoot = mkdtempSync(join(realTmpdir(), "maw-ui-tmp-"));
const distDir = join(homeDir, ".maw", "ui", "dist");

let spawnCalls: Array<{ cmd: string; args: string[] }> = [];
let spawnStatuses: Array<{ status: number; stdout?: string; stderr?: string }> = [];
let stdoutWrites: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let tarWritesFile = true;

const original = {
  write: process.stdout.write,
  log: console.log,
  error: console.error,
  dataDir: process.env.MAW_DATA_DIR,
};

mock.module("os", () => ({
  homedir: () => homeDir,
  tmpdir: () => tempRoot,
}));

mock.module("child_process", () => ({
  spawnSync: (cmd: string, args: string[] = []) => {
    spawnCalls.push({ cmd, args });
    const queued = spawnStatuses.shift();

    if (cmd === "tar" && tarWritesFile) {
      const cIndex = args.indexOf("-C");
      const target = cIndex >= 0 ? args[cIndex + 1] : distDir;
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "index.html"), '<div data-maw-ui-version="1.2.3"></div>');
    }

    return queued ?? { status: 0, stdout: "v9.9.9\n", stderr: "" };
  },
}));

const ui = await import("../../src/vendor/mpr-plugins/ui/ui-install.ts?ui-install-plugin-coverage");
const { buildGhReleaseArgs, cmdUiInstall, cmdUiStatus, resolveInstalledVersion, uiDistDir } = ui;

beforeEach(() => {
  rmSync(distDir, { recursive: true, force: true });
  spawnCalls = [];
  spawnStatuses = [];
  stdoutWrites = [];
  logs = [];
  errors = [];
  tarWritesFile = true;
  delete process.env.MAW_DATA_DIR;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  process.stdout.write = original.write;
  console.log = original.log;
  console.error = original.error;
  if (original.dataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = original.dataDir;
});

describe("ui install plugin coverage", () => {
  test("pure helpers resolve installed versions and gh download args", () => {
    const dir = mkdtempSync(join(tempRoot, "dist-"));
    expect(resolveInstalledVersion(dir)).toBeNull();

    writeFileSync(join(dir, "index.html"), '<html data-maw-ui-version="2.0.0"></html>');
    expect(resolveInstalledVersion(dir)).toBe("2.0.0");

    writeFileSync(join(dir, ".maw-ui-version"), "v3.0.0\n");
    expect(resolveInstalledVersion(dir)).toBe("v3.0.0");

    expect(buildGhReleaseArgs("owner/repo", undefined, "/tmp/out")).toEqual([
      "release", "download", "-R", "owner/repo", "--pattern", "maw-ui-dist.tar.gz", "--dir", "/tmp/out",
    ]);
    expect(buildGhReleaseArgs("owner/repo", "v1", "/tmp/out")).toEqual([
      "release", "download", "v1", "-R", "owner/repo", "--pattern", "maw-ui-dist.tar.gz", "--dir", "/tmp/out",
    ]);
  });

  test("status reports missing and installed dist with normalized version", async () => {
    await cmdUiStatus();
    expect(logs.join("\n")).toContain("maw-ui not installed");
    expect(logs.join("\n")).toContain("maw ui install");

    logs = [];
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), '<div data-maw-ui-version="4.5.6"></div>');
    writeFileSync(join(distDir, "app.js"), "console.log(1)");

    await cmdUiStatus();
    const out = logs.join("\n");
    expect(out).toContain("maw-ui v4.5.6");
    expect(out).toContain("2 top-level entries");
  });

  test("dist directory follows MAW_DATA_DIR for install/status paths", async () => {
    const dataDir = mkdtempSync(join(tempRoot, "maw-data-"));
    process.env.MAW_DATA_DIR = dataDir;
    const xdgDistDir = join(dataDir, "ui", "dist");

    expect(uiDistDir()).toBe(xdgDistDir);

    await cmdUiStatus();
    expect(logs.join("\n")).toContain("maw-ui not installed");

    logs = [];
    spawnStatuses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];

    await cmdUiInstall("v7.0.0");

    expect(spawnCalls.find((call) => call.cmd === "tar")?.args).toContain(xdgDistDir);
    expect(readFileSync(join(xdgDistDir, ".maw-ui-version"), "utf-8")).toBe("v7.0.0\n");
    expect(logs.join("\n")).toContain(xdgDistDir);
  });

  test("install downloads latest, extracts, writes resolved marker, and cleans temp dir", async () => {
    spawnStatuses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "v9.9.9\n", stderr: "" },
    ];

    await cmdUiInstall();

    expect(stdoutWrites.join("")).toContain("downloading maw-ui latest");
    expect(spawnCalls[0].cmd).toBe("gh");
    expect(spawnCalls[0].args).not.toContain("latest");
    expect(spawnCalls[1]).toMatchObject({ cmd: "tar" });
    expect(spawnCalls[2].args).toEqual(["release", "view", "-R", "Soul-Brews-Studio/maw-ui", "--json", "tagName", "-q", ".tagName"]);
    expect(readFileSync(join(distDir, ".maw-ui-version"), "utf-8")).toBe("v9.9.9\n");
    expect(logs.join("\n")).toContain("installed");
  });

  test("install uses explicit version and reports gh or tar failures", async () => {
    spawnStatuses = [{ status: 1, stderr: "missing asset" }];
    await expect(cmdUiInstall("v1.0.0")).rejects.toThrow("gh release download failed");
    expect(errors.join("\n")).toContain("ensure: gh auth status");
    expect(spawnCalls[0].args).toContain("v1.0.0");

    spawnCalls = [];
    errors = [];
  tarWritesFile = true;
    spawnStatuses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 2, stderr: "bad archive" },
    ];
    await expect(cmdUiInstall("v2.0.0")).rejects.toThrow("tar extraction failed");
  });

  test("install rejects empty extractions", async () => {
    tarWritesFile = false;
    spawnStatuses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];

    await expect(cmdUiInstall("v3.0.0")).rejects.toThrow("no files extracted");
  });

  test("latest install skips marker when tag lookup fails", async () => {
    spawnStatuses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "no tag" },
    ];

    await cmdUiInstall();

    expect(existsSync(join(distDir, ".maw-ui-version"))).toBe(false);
    expect(spawnCalls.at(-1)?.args).toEqual(["release", "view", "-R", "Soul-Brews-Studio/maw-ui", "--json", "tagName", "-q", ".tagName"]);
  });
});
