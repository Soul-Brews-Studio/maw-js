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
// openPlan governs the "wx" (acquire) opens only.  Stale-steal "r" opens are
// handled separately and return a dedicated read-fd so the acquire plan
// cursor is not consumed by the read path (#562 fd-based read/write).
let openPlan: Array<number | { code: string }> = []; // fd number OR error spec
let openCursor = 0;
const READ_FD = 7777; // arbitrary fd handed back for stale-read opens
let nowPlan: number[] = [];
let nowCursor = 0;
let realNow: () => number;
// readSyncImpl returns the bytes that the production code's readSync sees.
// It used to be readSyncImpl returning a string; under the fd-based read
// the impl writes into the caller-supplied buffer, so we model it that way.
let readSyncImpl: () => string = () => "";

// ── Install fs mock (openSync/closeSync/unlinkSync/existsSync/mkdirSync +
//    writeSync/readSync/fstatSync for the fd-based TOCTOU-safe path) ──────
await mock.module("fs", () => ({
  ...realFs,
  openSync: (path: string, flags: string) => {
    calls.push({ fn: "openSync", args: [path, flags] });
    // Stale-steal read path uses "r"; route to a dedicated fd so the acquire
    // plan cursor isn't consumed by reads.
    if (flags === "r") return READ_FD;
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
  writeSync: (fd: number, buf: Buffer, _off: number, _len: number, _pos: number) => {
    calls.push({ fn: "writeSync", args: [fd, buf.toString("utf-8")] });
    return buf.length;
  },
  fstatSync: (fd: number) => {
    calls.push({ fn: "fstatSync", args: [fd] });
    return { size: Buffer.byteLength(readSyncImpl()) } as ReturnType<typeof realFs.fstatSync>;
  },
  readSync: (fd: number, buf: Buffer, _off: number, _len: number, _pos: number) => {
    calls.push({ fn: "readSync", args: [fd] });
    const data = Buffer.from(readSyncImpl());
    const n = Math.min(buf.length, data.length);
    data.copy(buf, 0, 0, n);
    return n;
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
    // Mock lock holder as OUR pid so it's alive → forces wait path (not stale-steal)
    readSyncImpl = () => String(process.pid);
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

    // Only count acquire ("wx") opens — the fd-based stale-check also issues
    // an "r" open per #562, which is not part of the acquire-attempt count.
    const wxOpens = calls.filter((c) => c.fn === "openSync" && c.args[1] === "wx");
    expect(wxOpens.length).toBe(2);
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

  test("case 5 — stale lock with DEAD pid: immediate takeover (no 60s wait)", async () => {
    // First open returns EEXIST with a dead PID's content; cleanup + retry succeeds.
    openPlan = [
      { code: "EEXIST" },
      5, // succeeds after takeover unlink
    ];
    // readFileSync returns a PID that's guaranteed dead (pid 999999 extremely unlikely
    // to be live on the test host). kill(pid, 0) throws ESRCH → isAlive returns false.
    readSyncImpl = () => "999999";
    stubDateNow([0, 500, 500]);
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

    expect(warns.some((w) => w.includes("stale update lock") && w.includes("taking over"))).toBe(true);
    // Successful-open fd (5) eventually closed in finally.
    expect(calls.some((c) => c.fn === "closeSync" && c.args[0] === 5)).toBe(true);
  });

  test("case 6 — live PID holding lock past deadline: throws (doesn't steal)", async () => {
    // Lock holder's PID is our own process (definitely alive); after 60s wait, throw.
    openPlan = [
      { code: "EEXIST" },
      { code: "EEXIST" },
    ];
    readSyncImpl = () => String(process.pid);
    stubDateNow([0, 500, 61_000]);
    const { withUpdateLock } = await import("../../src/cli/update-lock");

    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = () => {};
    console.log = () => {};

    let caught: Error | null = null;
    try {
      await withUpdateLock(async () => {});
    } catch (e) {
      caught = e as Error;
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    expect(caught?.message).toContain("update lock timeout");
  });
});
