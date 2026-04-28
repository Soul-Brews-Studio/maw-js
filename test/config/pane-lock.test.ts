/**
 * Tests for withPaneLock from src/core/transport/tmux-pane-lock.ts.
 * Tests the Promise queue serialization — no tmux needed.
 */
import { describe, it, expect } from "bun:test";
import { withPaneLock } from "../../src/core/transport/tmux-pane-lock";

describe("withPaneLock", () => {
  it("executes a single function and returns result", async () => {
    const result = await withPaneLock(async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent calls", async () => {
    const order: number[] = [];
    const p1 = withPaneLock(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = withPaneLock(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    // p2 should wait for p1 to complete
    expect(order).toEqual([1, 2]);
  });

  it("releases lock even when function throws", async () => {
    // First call throws
    await withPaneLock(async () => { throw new Error("boom"); }).catch(() => {});
    // Second call should still work
    const result = await withPaneLock(async () => "ok");
    expect(result).toBe("ok");
  });

  it("propagates errors from the wrapped function", async () => {
    expect(
      withPaneLock(async () => { throw new Error("test error"); }),
    ).rejects.toThrow("test error");
  });

  it("handles three sequential tasks", async () => {
    const order: string[] = [];
    const p1 = withPaneLock(async () => { order.push("a"); });
    const p2 = withPaneLock(async () => { order.push("b"); });
    const p3 = withPaneLock(async () => { order.push("c"); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns different types", async () => {
    const str = await withPaneLock(async () => "hello");
    expect(str).toBe("hello");
    const arr = await withPaneLock(async () => [1, 2, 3]);
    expect(arr).toEqual([1, 2, 3]);
    const obj = await withPaneLock(async () => ({ key: "value" }));
    expect(obj).toEqual({ key: "value" });
  });
});
