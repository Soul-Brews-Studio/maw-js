/**
 * Tests for withPaneLock and splitWindowLocked
 * from src/core/transport/tmux-pane-lock.ts.
 * Mocks tmux to test serialization queue logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "pane-lock-"));

const runCalls: any[][] = [];

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

mock.module("../../src/core/transport/tmux-class", () => ({
  Tmux: class {},
  tmux: {
    run: async (...args: any[]) => { runCalls.push(args); return ""; },
    ls: async () => [],
    sendText: async () => {},
    kill: async () => {},
    killWindow: async () => {},
    listWindows: async () => [],
    listSessions: async () => [],
  },
}));

const { withPaneLock, splitWindowLocked } = await import(
  "../../src/core/transport/tmux-pane-lock"
);

beforeEach(() => {
  runCalls.length = 0;
});

describe("withPaneLock", () => {
  it("executes the function and returns result", async () => {
    const result = await withPaneLock(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent calls", async () => {
    const order: number[] = [];
    const a = withPaneLock(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    const b = withPaneLock(async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]); // second waits for first
  });

  it("releases lock even on error", async () => {
    try {
      await withPaneLock(async () => { throw new Error("boom"); });
    } catch {}
    // Next call should still work
    const result = await withPaneLock(async () => "ok");
    expect(result).toBe("ok");
  });

  it("propagates errors", async () => {
    expect(withPaneLock(async () => { throw new Error("test-error"); }))
      .rejects.toThrow("test-error");
  });
});

describe("splitWindowLocked", () => {
  it("calls tmux split-window with target", async () => {
    await splitWindowLocked("session:window", { settleMs: 0 });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0][0]).toBe("split-window");
    expect(runCalls[0]).toContain("-t");
    expect(runCalls[0]).toContain("session:window");
  });

  it("adds -v for vertical split", async () => {
    await splitWindowLocked("s:w", { vertical: true, settleMs: 0 });
    expect(runCalls[0]).toContain("-v");
  });

  it("adds -h for horizontal split", async () => {
    await splitWindowLocked("s:w", { vertical: false, settleMs: 0 });
    expect(runCalls[0]).toContain("-h");
  });

  it("adds percentage size", async () => {
    await splitWindowLocked("s:w", { pct: 30, settleMs: 0 });
    expect(runCalls[0]).toContain("-l");
    expect(runCalls[0]).toContain("30%");
  });

  it("adds shell command", async () => {
    await splitWindowLocked("s:w", { shellCommand: "bun run server", settleMs: 0 });
    expect(runCalls[0]).toContain("bun run server");
  });

  it("uses custom tmux instance", async () => {
    const customCalls: any[][] = [];
    const customTmux = {
      run: async (...args: any[]) => { customCalls.push(args); return ""; },
    };
    await splitWindowLocked("s:w", { tmux: customTmux as any, settleMs: 0 });
    expect(customCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(0); // global tmux not used
  });

  it("serializes concurrent splits", async () => {
    const order: number[] = [];
    const customTmux = {
      run: async (...args: any[]) => {
        await new Promise(r => setTimeout(r, 30));
        order.push(args.some((a: any) => String(a).includes("first")) ? 1 : 2);
        return "";
      },
    };
    const a = splitWindowLocked("s:first", { tmux: customTmux as any, settleMs: 0 });
    const b = splitWindowLocked("s:second", { tmux: customTmux as any, settleMs: 0 });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });
});
