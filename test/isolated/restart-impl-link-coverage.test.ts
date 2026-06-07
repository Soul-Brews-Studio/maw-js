/** Isolated SDK-link branch coverage for src/vendor/mpr-plugins/restart/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let execCalls: string[] = [];
let sleepCalls = 0;
let wakeCalls = 0;
let logs: string[] = [];
let homeDir = "";
let failCheckoutLink = false;
const originalEnv = {
  home: process.env.HOME,
  mawHome: process.env.MAW_HOME,
  mawDataDir: process.env.MAW_DATA_DIR,
  mawXdg: process.env.MAW_XDG,
};

class MockTmux {
  async killSession(_name: string) {}
}

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [],
  Tmux: MockTmux,
}));

mock.module("maw-js/commands/shared/fleet", () => ({
  cmdSleep: async () => { sleepCalls += 1; },
  cmdWakeAll: async () => { wakeCalls += 1; },
}));

mock.module("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    if (failCheckoutLink && cmd === "cd /tmp/maw-js-checkout && bun link") throw new Error("link failed");
    if (cmd === "maw --version") return "v9.9.9-linked\n";
    return "";
  },
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFindSync: () => "/tmp/maw-js-checkout",
}));

const { cmdRestart } = await import("../../src/vendor/mpr-plugins/restart/impl.ts?restart-impl-link-coverage");

beforeEach(() => {
  execCalls = [];
  sleepCalls = 0;
  wakeCalls = 0;
  logs = [];
  homeDir = mkdtempSync(join(tmpdir(), "restart-link-home-"));
  process.env.HOME = homeDir;
  delete process.env.MAW_HOME;
  process.env.MAW_DATA_DIR = join(homeDir, ".maw");
  delete process.env.MAW_XDG;
  failCheckoutLink = false;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
});

afterEach(() => {
  if (originalEnv.home === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.home;
  if (originalEnv.mawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalEnv.mawHome;
  if (originalEnv.mawDataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = originalEnv.mawDataDir;
  if (originalEnv.mawXdg === undefined) delete process.env.MAW_XDG;
  else process.env.MAW_XDG = originalEnv.mawXdg;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

describe("restart impl SDK link branch", () => {
  test("links local maw checkout into oracle plugin dir after update", async () => {
    await cmdRestart({ ref: "alpha" });

    expect(execCalls.slice(0, 3)).toEqual([
      "bun add -g github:Soul-Brews-Studio/maw-js#alpha",
      "maw --version",
      "cd /tmp/maw-js-checkout && bun link",
    ]);
    expect(execCalls[3]).toBe(`cd ${join(homeDir, ".maw", "oracle-plugins")} && bun link maw`);
    expect(existsSync(join(homeDir, ".maw", "oracle-plugins", "package.json"))).toBe(true);
    expect(logs.join("\n")).toContain("SDK linked");
    expect(sleepCalls).toBe(1);
    expect(wakeCalls).toBe(1);
  });

  test("continues restart when local SDK relink fails", async () => {
    failCheckoutLink = true;

    await cmdRestart({ ref: "alpha" });

    expect(execCalls).toContain("cd /tmp/maw-js-checkout && bun link");
    expect(logs.join("\n")).not.toContain("SDK linked");
    expect(sleepCalls).toBe(1);
    expect(wakeCalls).toBe(1);
  });
});
