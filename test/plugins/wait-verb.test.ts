import { describe, it, expect, beforeEach } from "bun:test";
import type { InvokeContext } from "../../src/plugin/types";
import { cmdWait, WaitTimeoutError } from "../../src/commands/plugins/wait/impl";

/**
 * Tests for `maw wait` — the third verb of the POSIX-style job-control trio
 * (#1306). Companion to `maw bg` + `maw shell` (#1304).
 *
 * Placed at `test/plugins/` (alongside `shell-bg-verbs.test.ts`) — NOT at
 * `src/commands/plugins/wait/wait.test.ts` — for the same shard-stability
 * reason documented in shell-bg-verbs.test.ts header. See PR #1307 retro
 * and #1308 for the underlying EEXIST shard-flake.
 *
 * Mocking strategy (#1312): Behavioral tests call `cmdWait` directly with
 * a `{tmux}` dependency-injection fake. This sidesteps the
 * `spyOn(tmux, ...)` foot-gun: under `bun run test` (no `--isolate`),
 * sibling test files mutate the shared `tmux` singleton at import-time,
 * leaving spyOn's `mockRestore` unable to clean up — 4 wait tests would
 * fail with module-pollution. DI fakes never touch the singleton, so
 * module order is irrelevant. Same pattern as #1309 for shell+bg.
 *
 * Handler-level concerns (parseFlags, --help, missing-arg usage prints)
 * are still tested via the index.ts `handler` — those code paths
 * short-circuit before touching tmux, so no mocking is needed.
 */

interface FakeTmux {
  hasSession: (name: string) => Promise<boolean>;
  _calls: { hasSession: string[] };
}

/** Fake whose `hasSession` returns each value from `queue` in turn, then
 *  `false` once the queue is drained. Mirrors the original spy-based
 *  helper but injected, not spied. */
function makeFakeTmux(queue: boolean[] = []): FakeTmux {
  const calls = { hasSession: [] as string[] };
  const remaining = [...queue];
  return {
    _calls: calls,
    async hasSession(name: string): Promise<boolean> {
      calls.hasSession.push(name);
      return remaining.shift() ?? false;
    },
  };
}

/** Fake whose `hasSession` always returns true — used for timeout cases. */
function makeAlwaysAliveTmux(): FakeTmux {
  const calls = { hasSession: [] as string[] };
  return {
    _calls: calls,
    async hasSession(name: string): Promise<boolean> {
      calls.hasSession.push(name);
      return true;
    },
  };
}

// -----------------------------------------------------------------------------
// maw wait — impl (DI-injected)
// -----------------------------------------------------------------------------

describe("maw wait impl", () => {
  let tmux: FakeTmux;

  beforeEach(() => {
    tmux = makeFakeTmux();
  });

  it("session never existed: returns immediately", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      await cmdWait("ghost", { tmux });
    } finally {
      console.log = origLog;
    }
    expect(tmux._calls.hasSession).toEqual(["ghost"]);
    expect(logs.join("\n")).toContain("not running");
  });

  it("session ends mid-wait: blocks then returns", async () => {
    tmux = makeFakeTmux([true, false]); // alive once, then ends
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      await cmdWait("builder", { tmux, intervalSec: 0.001 });
    } finally {
      console.log = origLog;
    }
    expect(tmux._calls.hasSession.length).toBeGreaterThanOrEqual(2);
    expect(logs.join("\n")).toContain("ended");
  });

  it("--timeout exceeded: throws WaitTimeoutError", async () => {
    tmux = makeAlwaysAliveTmux();
    let err: unknown;
    try {
      await cmdWait("stuck", { tmux, intervalSec: 0.05, timeoutSec: 0.01 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect(String((err as Error).message)).toMatch(/^timeout:/);
    expect(String((err as Error).message)).toContain("stuck");
  });

  it("missing name: throws usage error before touching tmux", async () => {
    let err: unknown;
    try {
      await cmdWait("", { tmux });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("required");
    expect(tmux._calls.hasSession).toHaveLength(0);
  });

  it("--interval 0: rejects with validation error", async () => {
    let err: unknown;
    try {
      await cmdWait("x", { tmux, intervalSec: 0 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("--interval");
  });

  it("--timeout 0: rejects with validation error", async () => {
    let err: unknown;
    try {
      await cmdWait("x", { tmux, timeoutSec: 0 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("--timeout");
  });

  it("custom intervalSec is plumbed through", async () => {
    tmux = makeFakeTmux([true, true, false]);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    const start = Date.now();
    try {
      await cmdWait("x", { tmux, intervalSec: 0.05 });
    } finally {
      console.log = origLog;
    }
    const elapsed = Date.now() - start;
    // Two intervals of 50ms after the fast-path check.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(tmux._calls.hasSession.length).toBeGreaterThanOrEqual(3);
  });
});

// -----------------------------------------------------------------------------
// maw wait — handler-level (parseFlags / usage prints; no tmux contact)
// -----------------------------------------------------------------------------

describe("maw wait handler", () => {
  let handler: (ctx: InvokeContext) => Promise<{ ok: boolean; output?: string; error?: string }>;

  beforeEach(async () => {
    const mod = await import("../../src/commands/plugins/wait/index");
    handler = mod.default;
  });

  it("missing name: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("--help: prints usage", async () => {
    const result = await handler({ source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw wait");
  });
});
