import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "fs";
import * as realChildProcess from "child_process";

const HOME = "/tmp/maw-coverage-next-vendor-b-doctor-home";
const BIN = `${HOME}/.bun/bin/maw`;
const C = { green: "", red: "", yellow: "", gray: "", reset: "" };

let logs: string[] = [];
let execCalls: string[] = [];

const originalLog = console.log;

mock.module("os", () => ({ homedir: () => HOME }));
mock.module("fs", () => ({
  ...realFs,
  existsSync: (path: string) => path === BIN ? false : realFs.existsSync(path),
  readFileSync: realFs.readFileSync,
  readlinkSync: realFs.readlinkSync,
}));
mock.module("child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    return "";
  },
}));
mock.module("maw-js/commands/shared/fleet-doctor-fixer", () => ({ C }));
mock.module("maw-js/config", () => ({ loadConfig: () => ({}) }));
mock.module("maw-js/lib/oracle-manifest", () => ({
  invalidateManifest: () => undefined,
  loadManifestCached: () => [],
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/peers-store.ts"), () => ({
  loadPeers: () => ({ peers: {} }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stale-peers.ts"), () => ({
  checkStalePeers: () => ({ name: "peers:stale", ok: true, message: "none" }),
  cmdFixStalePeers: async () => ({ ok: true, checks: [] }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/maw-js-branch-check.ts"), () => ({
  checkMawJsBranch: async () => ({ name: "maw-js:branch", ok: true, message: "ok" }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stillborn-worktrees.ts"), () => ({
  checkStillbornWorktrees: () => ({ name: "worktrees:stillborn", ok: true, message: "none" }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/bun-link-detect.ts"), () => ({
  detectBunLinkedCheckout: () => "/work/local-maw",
}));

const { cmdDoctor } = await import("../../src/vendor/mpr-plugins/doctor/impl.ts?coverage-next-vendor-b-doctor");

beforeEach(() => {
  logs = [];
  execCalls = [];
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
});

afterEach(() => {
  console.log = originalLog;
});

describe("coverage-next vendor-b doctor install branch", () => {
  test("missing binary reports the local linked checkout without reinstalling", async () => {
    const result = await cmdDoctor(["install"]);

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([{
      name: "install",
      ok: false,
      message: "dev bun-link at /work/local-maw — run bun link to restore",
    }]);
    expect(execCalls).toEqual([]);
    expect(logs.join("\n")).toContain("maw is bun-linked to dev checkout: /work/local-maw");
  });
});
