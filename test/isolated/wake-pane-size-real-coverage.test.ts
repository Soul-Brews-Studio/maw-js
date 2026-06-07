import { describe, expect, mock, test } from "bun:test";

const calls: Array<[string, ...unknown[]]> = [];

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  tmux: {
    setOption: async (...args: unknown[]) => calls.push(["setOption", ...args]),
    setEnvironment: async (...args: unknown[]) => calls.push(["setEnvironment", ...args]),
    resizeWindow: async (...args: unknown[]) => calls.push(["resizeWindow", ...args]),
  },
}));

const {
  CLAUDE_COLS,
  CLAUDE_ROWS,
  pinSessionWide,
  pinWindowWide,
} = await import("../../src/commands/shared/wake-pane-size");

describe("wake-pane-size real module coverage", () => {
  test("pinSessionWide pins manual size, env, and resize order", async () => {
    calls.length = 0;

    await pinSessionWide("02-neo");

    expect(CLAUDE_COLS).toBe(200);
    expect(CLAUDE_ROWS).toBe(50);
    expect(calls).toEqual([
      ["setOption", "02-neo", "window-size", "manual"],
      ["setEnvironment", "02-neo", "COLUMNS", "200"],
      ["setEnvironment", "02-neo", "LINES", "50"],
      ["resizeWindow", "02-neo", 200, 50],
    ]);
  });

  test("pinWindowWide resizes a specific pane or window target", async () => {
    calls.length = 0;

    await pinWindowWide("02-neo:editor");

    expect(calls).toEqual([
      ["resizeWindow", "02-neo:editor", 200, 50],
    ]);
  });
});
