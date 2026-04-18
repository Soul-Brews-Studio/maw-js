/**
 * #551 — withUpdateLock acquisition + release semantics.
 *
 * Contract under test (src/cli/update-lock.ts):
 *   - Acquires ~/.maw/update.lock via openSync(..., "wx") (O_EXCL).
 *   - On EEXIST, polls every 500ms up to 60s.
 *   - After 60s, unlinks stale lock + takes over with a warning.
 *   - Non-EEXIST errors propagate.
 *   - finally: closeSync(fd) + unlinkSync(LOCK_PATH) even when fn throws.
 *
 * Isolation: mock.module("fs", ...) so every fs op inside update-lock.ts
 * hits our stubs. We capture calls to assert order. Pass-through for dirs
 * (existsSync/mkdirSync) since update-lock creates ~/.maw if missing.
 *
 * mock.module is process-global — keep all state inside this file and
 * reset between tests via beforeEach.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Capture real fs before mocking ────────────────────────────────────────
const realFs = await import("fs");

// ── Shared spy state ──────────────────────────────────────────────────────
interface Call { fn: string; args: unknown[] }
let calls: Call[] = [];
let openPlan: Array<number | { code: string }> = []; // fd number OR error spec
let openCursor = 0;
let nowPlan: number[] = [];
let nowCursor = 0;
let realNow: () => number;

// ── Install fs mock (openSync/closeSync/unlinkSync/existsSync/mkdirSync) ─
await mock.module("fs", () => ({
  ...realFs,
  openSync: (path: string, flags: string) => {
    calls.push({ fn: "openSync", args: [path, flags] });
    const next = openPlan[Math.min(openCursor, openPlan.length - 1)];
    openCursor++;
    if (typeof next === "number") return next;
    const err: NodeJS.ErrnoException = new Error(`mock ${next.code}`);
    err.code = next.code;
    throw err;
  },
  closeSync: (fd: number) => {
    calls.push({ fn: "closeSync", args: [fd] });
  },
  unlinkSync: (path: string) => {
    calls.push({ fn: "unlinkSync", args: [path] });
  },
  existsSync: (path: string) => {
    calls.push({ fn: "existsSync", args: [path] });
    return true; // ~/.maw already exists in mock-world
  },
  mkdirSync: (path: string, opts: unknown) => {
    calls.push({ fn: "mkdirSync", args: [path, opts] });
  },
}));

// ── Test lifecycle ────────────────────────────────────────────────────────
beforeEach(() => {
  calls = [];
  openPlan = [];
  openCursor = 0;
  nowPlan = [];
  nowCursor = 0;
  realNow = Date.now;
});

afterEach(() => {
  Date.now = realNow;
});

function stubDateNow(plan: number[]): void {
  nowPlan = plan;
  nowCursor = 0;
  Date.now = () => {
    const v = nowPlan[Math.min(nowCursor, nowPlan.length - 1)];
    nowCursor++;
    return v;
  };
}

function callNames(): string[] {
  return calls.map((c) => c.fn);
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe("withUpdateLock — acquisition + release (#551)", () => {
  test("case 1 — clean acquire: fn runs, lock released in finally", async () => {
    openPlan = [42]; // fd 42 on first try
    const { withUpdateLock } = await import("../../src/cli/update-lock");

    let ran = false;
    const result = await withUpdateLock(async () => {
      ran = true;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(ran).toBe(true);
    // Expect: openSync acquires, then finally closeSync(42) + unlinkSync(lock)
    const names = callNames();
    expect(names).toContain("openSync");
    expect(names).toContain("closeSync");
    expect(names).toContain("unlinkSync");
    const closeCall = calls.find((c) => c.fn === "closeSync");
    expect(closeCall?.args[0]).toBe(42);
  });

  test("case 2 — EEXIST then success: polls, then fn runs", async () => {
    // First openSync → EEXIST. Second → fd 7.
    openPlan = [{ code: "EEXIST" }, 7];
    // Keep Date.now small so we stay under the 60s deadline.
    stubDateNow([1_000, 1_100, 1_200, 1_300, 1_400]);
    const { withUpdateLock } = await import("../../src/cli/update-lock");

    const origLog = console.log;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      let ran = false;
      await withUpdateLock(async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    } finally {
      console.log = origLog;
    }

    const opens = calls.filter((c) => c.fn === "openSync");
    expect(opens.length).toBe(2);
    // "waiting up to 60s" announcement printed once.
    expect(logs.some((l) => l.includes("waiting up to 60s"))).toBe(true);
  });

  test("case 3 — non-EEXIST error propagates", async () => {
    openPlan = [{ code: "EACCES" }];
    const { withUpdateLock } = await import("../../src/cli/update-lock");

    let caught: NodeJS.ErrnoException | null = null;
    try {
      await withUpdateLock(async () => {});
    } catch (e) {
      caught = e as NodeJS.ErrnoException;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("EACCES");
    // Should NOT have reached closeSync (we never acquired a fd).
    expect(calls.filter((c) => c.fn === "closeSync").length).toBe(0);
  });

  test("case 4 — fn throws: lock still released via finally", async () => {
    openPlan = [99];
    const { withUpdateLock } = await import("../../src/cli/update-lock");

    let caught: Error | null = null;
    try {
      await withUpdateLock(async () => {
        throw new Error("boom");
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("boom");

    // closeSync + unlinkSync both fired.
    const closes = calls.filter((c) => c.fn === "closeSync");
    const unlinks = calls.filter((c) => c.fn === "unlinkSync");
    expect(closes.length).toBe(1);
    expect(closes[0].args[0]).toBe(99);
    expect(unlinks.length).toBeGreaterThanOrEqual(1);
  });

  test("case 5 — stale lock >60s: warns, unlinks, takes over", async () => {
    // Every open returns EEXIST until we push past the deadline; then fd 5.
    openPlan = [
      { code: "EEXIST" },
      { code: "EEXIST" },
      5, // succeeds after takeover unlink
    ];
    // Date.now progression: START, then two calls under deadline, then past 60s.
    // Module captures START = Date.now() as first call, then DEADLINE computed
    // inline. Loop calls Date.now() on each EEXIST iteration.
    stubDateNow([
      0,           // START
      500,         // first Date.now() > DEADLINE check (pre-deadline)
      61_000,      // second check — PAST deadline, triggers takeover
      61_000,      // subsequent
    ]);
    const { withUpdateLock } = await import("../../src/cli/update-lock");

    const origWarn = console.warn;
    const origLog = console.log;
    const warns: string[] = [];
    console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
    console.log = () => {};
    try {
      await withUpdateLock(async () => {});
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }

    expect(warns.some((w) => w.includes("taking over"))).toBe(true);
    // Stale lock was unlinked mid-loop (before the successful open).
    // Successful-open fd (5) eventually closed in finally.
    expect(calls.some((c) => c.fn === "closeSync" && c.args[0] === 5)).toBe(true);
  });
});
