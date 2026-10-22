import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

// job-1789785225-27090 — an empty `.git` dropped right at the ghq root makes
// `ghq list --full-path` collapse to a single entry (the root itself)
// instead of every real repo underneath, so `ghqFind` goes blind and `maw
// wake` reports a perfectly-cloned oracle as "not cloned locally". These
// tests pin the self-heal: an empty `.git` at the root gets removed before
// every `list()`/`listSync()`, and a non-empty one (a real repo someone put
// there on purpose) is left alone.

const srcRoot = join(import.meta.dir, "../..");

let hostValue = "";
let execValue = "";
let ghqRootValue = "/fake/ghq/root";

let readdirCalls: string[] = [];
let readdirResult: string[] | "throw-enoent" = "throw-enoent";
let rmdirCalls: string[] = [];
let appendFileCalls: Array<{ path: string; data: string }> = [];
let errors: string[] = [];

mock.module(join(srcRoot, "src/core/transport/ssh"), () => ({
  hostExec: async () => hostValue,
}));

mock.module("child_process", () => ({
  execSync: () => execValue,
}));

mock.module(join(srcRoot, "src/config/ghq-root"), () => ({
  getGhqRoot: () => ghqRootValue,
}));

mock.module(join(srcRoot, "src/core/xdg"), () => ({
  legacyMawPath: (...parts: string[]) => join("/fake/home/.maw", ...parts),
}));

mock.module("fs", () => ({
  readdirSync: (path: string) => {
    readdirCalls.push(path);
    if (readdirResult === "throw-enoent") {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return readdirResult;
  },
  rmdirSync: (path: string) => {
    rmdirCalls.push(path);
  },
  appendFileSync: (path: string, data: string) => {
    appendFileCalls.push({ path, data });
  },
}));

const { GhqDiscovery } = await import("../../src/core/repo-discovery/ghq-discovery.ts?poison-pill");

const originalConsoleError = console.error;

beforeEach(() => {
  hostValue = "/fake/ghq/root/github.com/org/repo\n";
  execValue = "/fake/ghq/root/github.com/org/repo\n";
  ghqRootValue = "/fake/ghq/root";
  readdirCalls = [];
  readdirResult = "throw-enoent";
  rmdirCalls = [];
  appendFileCalls = [];
  errors = [];
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
});

afterEach(() => {
  console.error = originalConsoleError;
});

describe("GhqDiscovery self-heals the ghq-root poison pill", () => {
  test("no .git at the root — list() doesn't touch the filesystem beyond the check", async () => {
    await GhqDiscovery.list();
    expect(readdirCalls).toEqual([join("/fake/ghq/root", ".git")]);
    expect(rmdirCalls).toEqual([]);
  });

  test("empty .git at the root — list() removes it, warns loudly, and logs the sighting", async () => {
    readdirResult = [];
    await GhqDiscovery.list();
    expect(rmdirCalls).toEqual([join("/fake/ghq/root", ".git")]);
    expect(errors.some((line) => line.includes("empty .git") && line.includes("not the cause of a real missing clone"))).toBe(true);
    expect(appendFileCalls).toHaveLength(1);
    expect(appendFileCalls[0]!.path).toBe(join("/fake/home/.maw", "ghq-root-intruder.log"));
    expect(appendFileCalls[0]!.data).toContain("maw self-heal:");
  });

  test("empty .git at the root — listSync() removes it before shelling out", () => {
    readdirResult = [];
    GhqDiscovery.listSync();
    expect(rmdirCalls).toEqual([join("/fake/ghq/root", ".git")]);
  });

  test("non-empty .git at the root — a real repo is left alone, no warning, no log", async () => {
    readdirResult = ["HEAD", "objects", "refs"];
    await GhqDiscovery.list();
    expect(rmdirCalls).toEqual([]);
    expect(errors).toEqual([]);
    expect(appendFileCalls).toEqual([]);
  });

  test("getGhqRoot() throwing doesn't break list()", async () => {
    ghqRootValue = undefined as unknown as string; // forces join() to throw inside the try/catch
    await expect(GhqDiscovery.list()).resolves.toEqual(["/fake/ghq/root/github.com/org/repo"]);
  });
});
