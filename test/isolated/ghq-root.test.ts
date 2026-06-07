import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { homedir } from "os";

let cfg: { ghqRoot?: string } | null = null;
let loadThrows = false;
let execCalls = 0;
let execValue = "";
let execThrows = false;

mock.module(import.meta.resolve("../../src/config/load"), () => ({
  loadConfig: () => {
    if (loadThrows) throw new Error("config boom");
    return cfg ?? {};
  },
}));

mock.module("child_process", () => ({
  execSync: () => {
    execCalls += 1;
    if (execThrows) throw new Error("ghq missing");
    return execValue;
  },
}));

const ghq = await import("../../src/config/ghq-root");

let stderrWrites: string[] = [];
let oldGhqRoot: string | undefined;
let oldWrite: typeof process.stderr.write;

beforeEach(() => {
  cfg = null;
  loadThrows = false;
  execCalls = 0;
  execValue = "";
  execThrows = false;
  stderrWrites = [];
  oldGhqRoot = process.env.GHQ_ROOT;
  delete process.env.GHQ_ROOT;
  oldWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  ghq.resetGhqRootCache();
});

afterEach(() => {
  if (oldGhqRoot === undefined) delete process.env.GHQ_ROOT;
  else process.env.GHQ_ROOT = oldGhqRoot;
  process.stderr.write = oldWrite;
  ghq.resetGhqRootCache();
});

describe("getGhqRoot", () => {
  test("legacy config ghqRoot wins, normalizes github.com suffix, warns once, and caches", () => {
    cfg = { ghqRoot: "/tmp/Code/github.com/" };

    expect(ghq.getGhqRoot()).toBe("/tmp/Code");
    expect(ghq.getGhqRoot()).toBe("/tmp/Code");

    expect(stderrWrites).toHaveLength(1);
    expect(stderrWrites[0]).toContain("config.ghqRoot is deprecated");
    expect(stderrWrites[0]).toContain("/tmp/Code");
    expect(execCalls).toBe(0);
  });

  test("GHQ_ROOT env is used when config lacks ghqRoot", () => {
    cfg = {};
    process.env.GHQ_ROOT = "/opt/ghq/github.com///";

    expect(ghq.getGhqRoot()).toBe("/opt/ghq");
    expect(stderrWrites).toEqual([]);
    expect(execCalls).toBe(0);
  });

  test("loadConfig failures are ignored before env lookup", () => {
    loadThrows = true;
    process.env.GHQ_ROOT = "/env/ghq";

    expect(ghq.getGhqRoot()).toBe("/env/ghq");
    expect(execCalls).toBe(0);
  });

  test("falls back to ghq root CLI output and caches the normalized result", () => {
    cfg = {};
    execValue = "/Users/nat/Code/github.com\n";

    expect(ghq.getGhqRoot()).toBe("/Users/nat/Code");
    expect(ghq.getGhqRoot()).toBe("/Users/nat/Code");

    expect(execCalls).toBe(1);
  });

  test("empty or failing ghq CLI falls back to ~/Code without throwing", () => {
    cfg = {};
    execValue = "\n";
    expect(ghq.getGhqRoot()).toBe(join(homedir(), "Code"));

    ghq.resetGhqRootCache();
    execThrows = true;
    expect(ghq.getGhqRoot()).toBe(join(homedir(), "Code"));
  });
});
