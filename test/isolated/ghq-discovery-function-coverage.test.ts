import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
let hostValue = "";
let hostThrows = false;
let execValue = "";
let execThrows = false;

mock.module(join(srcRoot, "src/core/transport/ssh"), () => ({
  hostExec: async () => {
    if (hostThrows) throw new Error("host unavailable");
    return hostValue;
  },
}));

mock.module("child_process", () => ({
  execSync: () => {
    if (execThrows) throw new Error("ghq unavailable");
    return execValue;
  },
}));

const { GhqDiscovery, _normalize } = await import("../../src/core/repo-discovery/ghq-discovery.ts?function-coverage");

beforeEach(() => {
  hostValue = "/opt/Code/github.com/org/Repo\nC:\\Users\\Nat\\Code\\github.com\\org\\Other\n";
  hostThrows = false;
  execValue = "/opt/Code/github.com/org/Repo\n/opt/Code/github.com/org/Other\n";
  execThrows = false;
});

describe("GhqDiscovery function coverage", () => {
  test("normalizes output and finds suffixes in async and sync modes", async () => {
    expect(_normalize("C:\\a\\b\n\n/D/e\n")).toEqual(["C:/a/b", "/D/e"]);

    await expect(GhqDiscovery.list()).resolves.toEqual([
      "/opt/Code/github.com/org/Repo",
      "C:/Users/Nat/Code/github.com/org/Other",
    ]);
    await expect(GhqDiscovery.findBySuffix("/repo$")).resolves.toBe("/opt/Code/github.com/org/Repo");
    await expect(GhqDiscovery.findBySuffix("/missing$")).resolves.toBeNull();

    expect(GhqDiscovery.listSync()).toEqual([
      "/opt/Code/github.com/org/Repo",
      "/opt/Code/github.com/org/Other",
    ]);
    expect(GhqDiscovery.findBySuffixSync("/OTHER$")).toBe("/opt/Code/github.com/org/Other");
    expect(GhqDiscovery.findBySuffixSync("/missing")).toBeNull();
  });

  test("list fallbacks return empty arrays when ghq access fails", async () => {
    hostThrows = true;
    execThrows = true;
    await expect(GhqDiscovery.list()).resolves.toEqual([]);
    expect(GhqDiscovery.listSync()).toEqual([]);
  });
});
