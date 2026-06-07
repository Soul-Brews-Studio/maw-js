import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";

import {
  acquirePidLock,
  pidFile,
  printServeStatusWithPlugins,
  serveStatus,
  stopServe,
} from "../../src/cli/instance-pid";
import { scanCommands, matchCommand } from "../../src/cli/command-registry";
import { _test, pickOracle, resolveOracle } from "../../src/core/resolve";

const originalKill = process.kill;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const tempHomes: string[] = [];

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "maw-cli-core-gap-"));
  tempHomes.push(home);
  process.env.MAW_HOME = home;
  return home;
}

afterEach(() => {
  process.kill = originalKill;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env.MAW_HOME;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
});

describe("instance pid coverage gaps", () => {
  test("treats EPERM pid probes as alive and renders engine registrations", async () => {
    const home = withTempHome();
    writeFileSync(join(home, "maw.pid"), "4242\n");
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return true;
    }) as typeof process.kill;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://engine.test/api/_engine/registrations");
      return {
        ok: true,
        json: async () => ({
          registrations: [
            {
              plugin: "alpha",
              prefix: "/alpha",
              upstream: "http://upstream",
              health: "ok",
              events: ["feed", "tick"],
            },
            { plugin: 7, prefix: null, upstream: undefined, events: [] },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    expect(serveStatus()).toEqual({ pid: 4242, alive: true, file: join(home, "maw.pid") });
    await printServeStatusWithPlugins("http://engine.test");

    expect(logs.some((line) => line.includes("maw serve: running (PID 4242"))).toBe(true);
    expect(logs).toContain("engine plugins (http://engine.test):");
    expect(logs).toContain("  - alpha: /alpha → http://upstream health=ok events=feed,tick");
    expect(logs).toContain("  - unknown: unknown-prefix → unknown-upstream");
  });

  test("reports unavailable engine registrations and stopServe terminates live pid", async () => {
    const home = withTempHome();
    writeFileSync(join(home, "maw.pid"), "5252");
    const logs: string[] = [];
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill;
    globalThis.fetch = (async () => ({ ok: false, status: 503 } as Response)) as typeof fetch;

    await printServeStatusWithPlugins("http://engine.test");
    stopServe();

    expect(logs).toContain("engine plugins: unavailable (http://engine.test: HTTP 503)");
    expect(kills).toContainEqual({ pid: 5252, signal: 0 });
    expect(kills).toContainEqual({ pid: 5252, signal: "SIGTERM" });
    expect(serveStatus().pid).toBeNull();
  });

  test("force takeover removes a live stale lock and writes the current pid", () => {
    const home = withTempHome();
    writeFileSync(join(home, "maw.pid"), "6262");
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    acquirePidLock("blue", { forceTakeover: true });

    expect(kills).toContainEqual({ pid: 6262, signal: 0 });
    expect(kills).toContainEqual({ pid: 6262, signal: "SIGTERM" });
    expect(readFileSync(pidFile(), "utf-8")).toBe(String(process.pid));
  });
});

describe("command registry coverage gaps", () => {
  test("loads array-named command plugins through their canonical name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-command-registry-gap-"));
    try {
      writeFileSync(join(dir, "array-name.ts"), `
        export const command = { name: ["test-gap-array", "tga"], description: "array name" };
        export default async function() {}
      `);

      expect(await scanCommands(dir, "user")).toBe(1);
      expect(matchCommand(["test-gap-array"])?.desc.description).toBe("array name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("core resolver coverage gaps", () => {
  test("exposes helper normalization and invalid picker choices", async () => {
    expect(_test.refSlug({ owner: "Org", repo: "opal-oracle" })).toBe("Org/opal-oracle");
    expect(_test.repoNameFromPath("/gh/Org/opal-oracle")).toBe("opal-oracle");
    await expect(pickOracle([])).resolves.toBeNull();

    const invalidReader = new PassThrough();
    invalidReader.end("9\n");
    await expect(pickOracle([
      { owner: "Org", repo: "one-oracle", path: "/gh/Org/one-oracle" },
    ], {
      stream: { write: () => true },
      reader: invalidReader,
    })).resolves.toBeNull();
  });

  test("namespace owner matching supports non-exact policies", async () => {
    await expect(resolveOracle("Org/alp", {
      nameSpace: "any",
      matchPolicy: "prefix",
      repos: ["/gh/Org/alpha-oracle"],
    })).resolves.toEqual({
      kind: "exact",
      oracle: { owner: "Org", repo: "alpha-oracle", path: "/gh/Org/alpha-oracle" },
    });

    await expect(resolveOracle("Other/lph", {
      nameSpace: "any",
      matchPolicy: "substring",
      repos: ["/gh/Org/alpha-oracle"],
    })).resolves.toEqual({ kind: "not-found" });
  });
});
