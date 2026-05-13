import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import type { InvokeContext } from "../../src/plugin/types";
import { tmux } from "../../src/core/transport/tmux-class";

/**
 * Tests for `maw wait` — the third verb of the POSIX-style job-control trio
 * (#1306). Companion to `maw bg` + `maw shell` (#1304).
 *
 * Placed at `test/plugins/` (alongside `shell-bg-verbs.test.ts`) — NOT at
 * `src/commands/plugins/wait/wait.test.ts` — for the same shard-stability
 * reason documented in shell-bg-verbs.test.ts header. See PR #1307 retro
 * and #1308 for the underlying EEXIST shard-flake.
 *
 * Mocking strategy: `spyOn(tmux, "hasSession")` + `mockRestore` in afterEach
 * so the live `tmux` singleton is patched per-test only. Avoids
 * `mock.module` global pollution.
 */

let aliveQueue: boolean[] = [];
const calls: { hasSession: string[] } = { hasSession: [] };

function resetCalls(): void {
  calls.hasSession.length = 0;
  aliveQueue = [];
}

/** Push a sequence of has-session results. Each call to `tmux.hasSession`
 *  consumes one. If the queue empties, returns `false` (i.e. ended). */
function queueAlive(...values: boolean[]): void {
  aliveQueue.push(...values);
}

function installSpies(): { has: any } {
  const has = spyOn(tmux, "hasSession").mockImplementation(async (name: string) => {
    calls.hasSession.push(name);
    return aliveQueue.shift() ?? false;
  });
  return { has };
}

describe("maw wait plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;
  let spies: { has: any };

  beforeEach(async () => {
    resetCalls();
    spies = installSpies();
    const mod = await import("../../src/commands/plugins/wait/index");
    handler = mod.default;
  });

  afterEach(() => {
    spies.has.mockRestore();
    mock.restore();
  });

  // Arg-shape note: ctx.args from the real CLI dispatcher does NOT include
  // the command name (dispatcher strips it via `args.slice(matchedWords)`).
  // Tests pass the real shape `[<name>, ...flags]` so they catch regressions
  // in the skip=0 parseFlags wiring.

  it("session never existed: returns immediately", async () => {
    queueAlive(false);
    const result = await handler({ source: "cli", args: ["ghost"] });
    expect(result.ok).toBe(true);
    expect(calls.hasSession).toEqual(["ghost"]);
    expect(result.output).toContain("not running");
  });

  it("session ends mid-wait: blocks then returns", async () => {
    // alive once (fast path), then ends on next poll
    queueAlive(true, false);
    const result = await handler({
      source: "cli",
      // 1ms interval keeps test instant
      args: ["builder", "--interval", "0.001"],
    });
    expect(result.ok).toBe(true);
    expect(calls.hasSession.length).toBeGreaterThanOrEqual(2);
    expect(result.output).toContain("ended");
  });

  it("--timeout exceeded: returns ok=false with timeout: prefix", async () => {
    // Keep returning true forever — timeout must kick in.
    spies.has.mockImplementation(async (name: string) => {
      calls.hasSession.push(name);
      return true;
    });
    const result = await handler({
      source: "cli",
      args: ["stuck", "--interval", "0.05", "--timeout", "0.01"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^timeout:/);
    expect(result.error).toContain("stuck");
  });

  it("missing name: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
    expect(calls.hasSession).toHaveLength(0);
  });

  it("--help: prints usage, does not poll", async () => {
    const result = await handler({ source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw wait");
    expect(calls.hasSession).toHaveLength(0);
  });

  it("--interval 0: rejects with validation error", async () => {
    queueAlive(true);
    const result = await handler({
      source: "cli",
      args: ["x", "--interval", "0"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--interval");
    // hasSession may still have been called by the fast-path check — that's fine.
  });

  it("--timeout 0: rejects with validation error", async () => {
    queueAlive(true);
    const result = await handler({
      source: "cli",
      args: ["x", "--timeout", "0"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--timeout");
  });

  it("custom --interval is plumbed through", async () => {
    queueAlive(true, true, false);
    const start = Date.now();
    const result = await handler({
      source: "cli",
      args: ["x", "--interval", "0.05"],
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    // Two intervals of 50ms after the fast-path check.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(calls.hasSession.length).toBeGreaterThanOrEqual(3);
  });
});
