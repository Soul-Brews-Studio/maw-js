import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let mockActive = false;
// kobo-483: same fail-closed pattern as wake-cmd-cmdwake-coverage.test.ts —
// see that file's header comment for the full rationale. `hostExec` here
// runs a REAL `ghq get github.com/...` clone when it falls through; a leaked
// continuation reaching it mid-suite would clone a real repo to disk.
let suiteStarted = false;

function realCallForbidden(label: string): never {
  throw new Error(
    `[kobo-483 fail-closed] mockActive was false for "${label}" after the test suite ` +
    `had already started — refusing to fall through to the real implementation. ` +
    `Fix the race, don't restore the real passthrough.`,
  );
}

let ghqFindReturn: string | null = null;
let ghqFindCalls: string[] = [];
let hostExecCalls: string[] = [];
let hostExecError: unknown = null;
let logs: string[] = [];

const realSdk = { ...(await import("../src/sdk")) };
const realGhq = { ...(await import("../src/core/ghq")) };

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realSdk.hostExec(cmd);
      return realCallForbidden("hostExec");
    }
    hostExecCalls.push(cmd);
    if (hostExecError) throw hostExecError;
    return "";
  },
}));

mock.module(join(import.meta.dir, "../src/core/ghq"), () => ({
  ...realGhq,
  ghqFind: async (needle: string) => {
    if (!mockActive) {
      if (!suiteStarted) return realGhq.ghqFind(needle);
      return realCallForbidden("ghqFind");
    }
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
  suiteStarted = true; // kobo-483: never reset — marks "past the safe module-load window"
  ghqFindReturn = null;
  ghqFindCalls = [];
  hostExecCalls = [];
  hostExecError = null;
  logs = [];
});

afterEach(() => {
  mockActive = false;
});

// kobo-592: mock.module() replaces the process-WIDE module registry, not a
// per-file one — every later file sharing this test run/worker keeps seeing
// this file's mocked src/sdk + src/core/ghq (and hits realCallForbidden,
// since suiteStarted is deliberately never reset) unless something gives the
// registry its real implementation back. See comm-send-durable-inbox.test.ts
// for the full write-up (kobo-592 root cause) — same fix here.
afterAll(() => {
  mock.module(join(import.meta.dir, "../src/sdk"), () => realSdk);
  mock.module(join(import.meta.dir, "../src/core/ghq"), () => realGhq);
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
