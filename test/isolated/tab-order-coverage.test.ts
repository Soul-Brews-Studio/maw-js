import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let listWindowsQueue: Array<Array<{ index: number; name: string }> | Error> = [];
let runCalls: Array<{ cmd: string; args: Array<string | number> }> = [];
let runQueue: Array<string | Error> = [];

const originalHome = process.env.MAW_HOME;
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const home = mkdtempSync(join(tmpdir(), "maw-tab-order-"));
process.env.MAW_HOME = home;
delete process.env.MAW_CONFIG_DIR;

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    listWindows: async (_session: string) => {
      const next = listWindowsQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
    run: async (cmd: string, ...args: Array<string | number>) => {
      runCalls.push({ cmd, args });
      const next = runQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    },
  },
}));

const { restoreTabOrder, saveTabOrder, tabOrderDir } = await import("../../src/core/fleet/tab-order");

beforeEach(() => {
  rmSync(join(home, "tab-order"), { recursive: true, force: true });
  mkdirSync(join(home, "tab-order"), { recursive: true });
  listWindowsQueue = [];
  runCalls = [];
  runQueue = [];
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
});

function tabOrderPath(session: string) {
  return join(home, "tab-order", `${session}.json`);
}

function writeSavedOrder(session: string, contents: string) {
  writeFileSync(tabOrderPath(session), contents);
}

describe("tab order persistence coverage", () => {
  test("saveTabOrder sorts windows by index and writes stable JSON", async () => {
    listWindowsQueue = [[
      { index: 2, name: "third" },
      { index: 0, name: "first" },
      { index: 1, name: "second" },
    ]];

    await saveTabOrder("alpha");

    expect(JSON.parse(readFileSync(tabOrderPath("alpha"), "utf-8"))).toEqual([
      { index: 0, name: "first" },
      { index: 1, name: "second" },
      { index: 2, name: "third" },
    ]);
  });

  test("saveTabOrder swallows missing tmux sessions without creating a file", async () => {
    listWindowsQueue = [new Error("no such session")];

    await saveTabOrder("missing");

    expect(existsSync(tabOrderPath("missing"))).toBe(false);
  });

  test("restoreTabOrder returns zero for missing, malformed, and empty order files", async () => {
    expect(await restoreTabOrder("none")).toBe(0);

    writeSavedOrder("bad", "not-json");
    expect(await restoreTabOrder("bad")).toBe(0);

    writeSavedOrder("empty", "[]\n");
    expect(await restoreTabOrder("empty")).toBe(0);
    expect(runCalls).toEqual([]);
  });

  test("restoreTabOrder swaps occupied targets, skips missing/already-placed windows, and removes the saved file", async () => {
    writeSavedOrder("beta", JSON.stringify([
      { index: 0, name: "editor" },
      { index: 1, name: "gone" },
      { index: 2, name: "logs" },
    ]));
    listWindowsQueue = [
      [
        { index: 0, name: "shell" },
        { index: 1, name: "editor" },
        { index: 2, name: "logs" },
      ],
      [
        { index: 0, name: "editor" },
        { index: 2, name: "logs" },
      ],
      [
        { index: 0, name: "editor" },
        { index: 2, name: "logs" },
      ],
    ];

    expect(await restoreTabOrder("beta")).toBe(1);
    expect(runCalls).toEqual([
      { cmd: "swap-window", args: ["-s", "beta:1", "-t", "beta:0"] },
    ]);
    expect(existsSync(tabOrderPath("beta"))).toBe(false);
  });

  test("restoreTabOrder falls back from failed swap to move-window and moves into empty targets", async () => {
    writeSavedOrder("gamma", JSON.stringify([
      { index: 0, name: "editor" },
      { index: 4, name: "logs" },
    ]));
    listWindowsQueue = [
      [
        { index: 0, name: "shell" },
        { index: 1, name: "editor" },
        { index: 2, name: "logs" },
      ],
      [
        { index: 0, name: "editor" },
        { index: 2, name: "logs" },
      ],
    ];
    runQueue = [new Error("swap failed"), "", ""];

    expect(await restoreTabOrder("gamma")).toBe(2);
    expect(runCalls).toEqual([
      { cmd: "swap-window", args: ["-s", "gamma:1", "-t", "gamma:0"] },
      { cmd: "move-window", args: ["-s", "gamma:1", "-t", "gamma:0"] },
      { cmd: "move-window", args: ["-s", "gamma:2", "-t", "gamma:4"] },
    ]);
  });

  test("restoreTabOrder ignores move failures and stops when live window listing later fails", async () => {
    writeSavedOrder("delta", JSON.stringify([
      { index: 4, name: "editor" },
      { index: 0, name: "logs" },
    ]));
    listWindowsQueue = [
      [
        { index: 1, name: "editor" },
        { index: 2, name: "logs" },
      ],
      new Error("tmux died"),
    ];
    runQueue = [new Error("move failed")];

    expect(await restoreTabOrder("delta")).toBe(0);
    expect(runCalls).toEqual([
      { cmd: "move-window", args: ["-s", "delta:1", "-t", "delta:4"] },
    ]);
    expect(existsSync(tabOrderPath("delta"))).toBe(false);
  });

  test("resolves the tab-order state directory at operation time", async () => {
    const dynamicHome = mkdtempSync(join(tmpdir(), "maw-tab-order-dynamic-"));
    process.env.MAW_HOME = dynamicHome;
    try {
      expect(tabOrderDir()).toBe(join(dynamicHome, "tab-order"));
      listWindowsQueue = [[
        { index: 0, name: "main" },
        { index: 1, name: "logs" },
      ]];

      await saveTabOrder("dynamic");

      const dynamicFile = join(dynamicHome, "tab-order", "dynamic.json");
      expect(JSON.parse(readFileSync(dynamicFile, "utf-8"))).toEqual([
        { index: 0, name: "main" },
        { index: 1, name: "logs" },
      ]);
    } finally {
      process.env.MAW_HOME = home;
      rmSync(dynamicHome, { recursive: true, force: true });
    }
  });
});
