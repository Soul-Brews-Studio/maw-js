import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let mockActive = false;
let ghqFindReturn: string | null = null;
let ghqFindCalls: string[] = [];
let hostExecCalls: string[] = [];
let hostExecError: unknown = null;
let logs: string[] = [];

const realSdk = await import("../src/sdk");
const realGhq = await import("../src/core/ghq");

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string) => {
    if (!mockActive) return realSdk.hostExec(cmd);
    hostExecCalls.push(cmd);
    if (hostExecError) throw hostExecError;
    return "";
  },
}));

mock.module(join(import.meta.dir, "../src/core/ghq"), () => ({
  ...realGhq,
  ghqFind: async (needle: string) => {
    if (!mockActive) return realGhq.ghqFind(needle);
    ghqFindCalls.push(needle);
    return ghqFindReturn;
  },
}));

const { ensureCloned } = await import("../src/commands/shared/wake-target");

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const originalLog = console.log;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
    return logs;
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  mockActive = true;
  ghqFindReturn = null;
  ghqFindCalls = [];
  hostExecCalls = [];
  hostExecError = null;
  logs = [];
});

afterEach(() => {
  mockActive = false;
});

describe("ensureCloned", () => {
  test("returns without cloning when ghq already has the slug", async () => {
    ghqFindReturn = "/ghq/github.com/org/repo";

    await ensureCloned("org/repo");

    expect(ghqFindCalls).toEqual(["/org/repo"]);
    expect(hostExecCalls).toEqual([]);
  });

  test("clones a missing slug via ghq get", async () => {
    const rendered = await captureLogs(() => ensureCloned("org/repo"));

    expect(ghqFindCalls).toEqual(["/org/repo"]);
    expect(hostExecCalls).toEqual(["ghq get github.com/org/repo"]);
    expect(rendered.join("\n")).toContain("cloning org/repo");
  });

  test("throws clone failures for explicit targets", async () => {
    hostExecError = new Error("network down");

    await expect(captureLogs(() => ensureCloned("org/repo"))).rejects.toThrow("ghq get failed for org/repo: network down");
    expect(hostExecCalls).toEqual(["ghq get github.com/org/repo"]);
  });
});
