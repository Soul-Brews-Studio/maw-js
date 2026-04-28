/**
 * Tests for saveTabOrder and restoreTabOrder from src/core/fleet/tab-order.ts.
 * Mocks tmux to test tab ordering save/restore logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "tab-order-"));

let listWindowsResult: { index: number; name: string; active: boolean }[] = [];
const runCalls: string[][] = [];

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    listWindows: async () => listWindowsResult,
    run: async (...args: string[]) => {
      runCalls.push(args);
      return "";
    },
    ls: async () => [],
    sendText: async () => {},
    kill: async () => {},
    killWindow: async () => {},
  },
}));

const { saveTabOrder, restoreTabOrder } = await import(
  "../../src/core/fleet/tab-order"
);

beforeEach(() => {
  listWindowsResult = [];
  runCalls.length = 0;
});

describe("saveTabOrder", () => {
  it("writes window order to JSON file", async () => {
    listWindowsResult = [
      { index: 0, name: "neo-oracle", active: true },
      { index: 1, name: "pulse-oracle", active: false },
    ];
    await saveTabOrder("my-session");
    const filePath = join(tmp, "tab-order", "my-session.json");
    expect(existsSync(filePath)).toBe(true);
    const saved = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(saved).toHaveLength(2);
    expect(saved[0].name).toBe("neo-oracle");
    expect(saved[1].name).toBe("pulse-oracle");
  });

  it("sorts by index", async () => {
    listWindowsResult = [
      { index: 2, name: "c", active: false },
      { index: 0, name: "a", active: true },
      { index: 1, name: "b", active: false },
    ];
    await saveTabOrder("sorted");
    const saved = JSON.parse(readFileSync(join(tmp, "tab-order", "sorted.json"), "utf-8"));
    expect(saved[0].name).toBe("a");
    expect(saved[1].name).toBe("b");
    expect(saved[2].name).toBe("c");
  });
});

describe("restoreTabOrder", () => {
  it("returns 0 when no saved order", async () => {
    const result = await restoreTabOrder("nonexistent");
    expect(result).toBe(0);
  });

  it("returns 0 for empty saved order", async () => {
    writeFileSync(join(tmp, "tab-order", "empty.json"), "[]");
    const result = await restoreTabOrder("empty");
    expect(result).toBe(0);
  });

  it("returns 0 when windows already in place", async () => {
    const orderFile = join(tmp, "tab-order", "inplace.json");
    writeFileSync(orderFile, JSON.stringify([
      { index: 0, name: "a" },
      { index: 1, name: "b" },
    ]));
    listWindowsResult = [
      { index: 0, name: "a", active: true },
      { index: 1, name: "b", active: false },
    ];
    const result = await restoreTabOrder("inplace");
    expect(result).toBe(0);
    expect(runCalls).toHaveLength(0);
  });

  it("swaps misplaced windows", async () => {
    const orderFile = join(tmp, "tab-order", "swap.json");
    writeFileSync(orderFile, JSON.stringify([
      { index: 0, name: "b" },
      { index: 1, name: "a" },
    ]));
    listWindowsResult = [
      { index: 0, name: "a", active: true },
      { index: 1, name: "b", active: false },
    ];
    const result = await restoreTabOrder("swap");
    expect(result).toBeGreaterThan(0);
    expect(runCalls.some(c => c[0] === "swap-window")).toBe(true);
  });

  it("cleans up order file after restore", async () => {
    const orderFile = join(tmp, "tab-order", "cleanup.json");
    writeFileSync(orderFile, JSON.stringify([{ index: 0, name: "a" }]));
    listWindowsResult = [{ index: 0, name: "a", active: true }];
    await restoreTabOrder("cleanup");
    expect(existsSync(orderFile)).toBe(false);
  });

  it("skips windows that no longer exist", async () => {
    const orderFile = join(tmp, "tab-order", "missing.json");
    writeFileSync(orderFile, JSON.stringify([
      { index: 0, name: "exists" },
      { index: 1, name: "gone" },
    ]));
    listWindowsResult = [{ index: 0, name: "exists", active: true }];
    const result = await restoreTabOrder("missing");
    expect(result).toBe(0);
  });
});
