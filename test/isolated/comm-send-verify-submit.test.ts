/**
 * #1907 — verifySubmitDelivered tests.
 *
 * Covers: delivered immediately, single-retry recovery, double-retry recovery,
 * exhausted retries (warning), capture failure (warning), sendKeys failure
 * on retry (warning), env-driven delay override, --no-verify-submit semantics.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { verifySubmitDelivered } from "../../src/commands/shared/comm-send";

let originalDelayEnv: string | undefined;

beforeEach(() => {
  originalDelayEnv = process.env.MAW_HEY_VERIFY_DELAY_MS;
  delete process.env.MAW_HEY_VERIFY_DELAY_MS;
});

afterEach(() => {
  if (originalDelayEnv === undefined) delete process.env.MAW_HEY_VERIFY_DELAY_MS;
  else process.env.MAW_HEY_VERIFY_DELAY_MS = originalDelayEnv;
});

describe("verifySubmitDelivered (#1907)", () => {
  test("delivered immediately when input area is clean", async () => {
    const result = await verifySubmitDelivered("sess:0", "hello world", {
      delayMs: 0,
      captureFn: async () => "claude\n> ",
      sendKeysFn: async () => { throw new Error("must not retry when delivered"); },
      sleepFn: async () => {},
    });
    expect(result).toEqual({ delivered: true, retriesNeeded: 0 });
  });

  test("one Enter retry recovers stuck state", async () => {
    let captureCalls = 0;
    let enterCalls = 0;
    const result = await verifySubmitDelivered("sess:0", "hello world", {
      delayMs: 0,
      captureFn: async () => {
        captureCalls += 1;
        // 1st check: stuck (message still in input line)
        // 2nd check: clean (message submitted via our retry Enter; input empty,
        // chat scrolled the message out of the 3-line tail)
        return captureCalls === 1 ? "previous chat\n> hello world" : "still-here\nstill-here2\n> ";
      },
      sendKeysFn: async (_t, text) => { enterCalls += 1; expect(text).toBe("\r"); },
      sleepFn: async () => {},
    });
    expect(result).toEqual({ delivered: true, retriesNeeded: 1 });
    expect(enterCalls).toBe(1);
  });

  test("two Enter retries recovers double-stuck state", async () => {
    let captureCalls = 0;
    let enterCalls = 0;
    const result = await verifySubmitDelivered("sess:0", "hello world", {
      delayMs: 0,
      captureFn: async () => {
        captureCalls += 1;
        return captureCalls < 3 ? "> hello world" : "> ";
      },
      sendKeysFn: async () => { enterCalls += 1; },
      sleepFn: async () => {},
    });
    expect(result).toEqual({ delivered: true, retriesNeeded: 2 });
    expect(enterCalls).toBe(2);
  });

  test("exhausted retries → warning, not delivered", async () => {
    let enterCalls = 0;
    const result = await verifySubmitDelivered("sess:0", "stuck forever", {
      delayMs: 0,
      captureFn: async () => "> stuck forever",
      sendKeysFn: async () => { enterCalls += 1; },
      sleepFn: async () => {},
    });
    expect(result.delivered).toBe(false);
    expect(result.retriesNeeded).toBe(2);
    expect(result.warning).toContain("submit unverified after 2 Enter retries");
    expect(enterCalls).toBe(2);
  });

  test("capture failure → warning, no retry", async () => {
    let enterCalls = 0;
    const result = await verifySubmitDelivered("sess:0", "msg", {
      delayMs: 0,
      captureFn: async () => { throw new Error("no tty"); },
      sendKeysFn: async () => { enterCalls += 1; },
      sleepFn: async () => {},
    });
    expect(result.delivered).toBe(false);
    expect(result.warning).toContain("submit unverified — capture-pane failed");
    expect(result.warning).toContain("no tty");
    expect(enterCalls).toBe(0);
  });

  test("sendKeys failure on retry → warning", async () => {
    const result = await verifySubmitDelivered("sess:0", "msg", {
      delayMs: 0,
      captureFn: async () => "> msg",
      sendKeysFn: async () => { throw new Error("tmux server gone"); },
      sleepFn: async () => {},
    });
    expect(result.delivered).toBe(false);
    expect(result.warning).toContain("Enter retry failed");
    expect(result.warning).toContain("tmux server gone");
    expect(result.retriesNeeded).toBe(1);
  });

  test("empty message → trivially delivered", async () => {
    const result = await verifySubmitDelivered("sess:0", "", {
      delayMs: 0,
      captureFn: async () => { throw new Error("must not capture"); },
      sendKeysFn: async () => { throw new Error("must not send"); },
      sleepFn: async () => {},
    });
    expect(result).toEqual({ delivered: true, retriesNeeded: 0 });
  });

  test("explicit opts.delayMs wins over env var", async () => {
    process.env.MAW_HEY_VERIFY_DELAY_MS = "5000";
    let sleptMs = 0;
    await verifySubmitDelivered("sess:0", "msg", {
      delayMs: 100,
      captureFn: async () => "> ",
      sleepFn: async (ms: number) => { sleptMs = ms; },
    });
    expect(sleptMs).toBe(100);
  });

  test("env var picked up when opts.delayMs unset", async () => {
    process.env.MAW_HEY_VERIFY_DELAY_MS = "150";
    let sleptMs = 0;
    await verifySubmitDelivered("sess:0", "msg", {
      captureFn: async () => "> ",
      sleepFn: async (ms: number) => { sleptMs = ms; },
    });
    expect(sleptMs).toBe(150);
  });

  test("default delay (800ms) used when env unset and opts unset", async () => {
    let sleptMs = 0;
    await verifySubmitDelivered("sess:0", "msg", {
      captureFn: async () => "> ",
      sleepFn: async (ms: number) => { sleptMs = ms; },
    });
    expect(sleptMs).toBe(800);
  });

  test("non-numeric env var falls back to default", async () => {
    process.env.MAW_HEY_VERIFY_DELAY_MS = "lots";
    let sleptMs = 0;
    await verifySubmitDelivered("sess:0", "msg", {
      captureFn: async () => "> ",
      sleepFn: async (ms: number) => { sleptMs = ms; },
    });
    expect(sleptMs).toBe(800);
  });

  test("only checks last 3 lines of capture (chat history scrolls out)", async () => {
    const captureBody = [
      "old line: hello world",
      "line two",
      "line three",
      "line four",
      "line five",
      "line six",
      "line seven (in tail)",
      "line eight (in tail)",
      "> ",
    ].join("\n");

    const result = await verifySubmitDelivered("sess:0", "hello world", {
      delayMs: 0,
      captureFn: async () => captureBody,
      sendKeysFn: async () => { throw new Error("must not retry; history match should not trigger"); },
      sleepFn: async () => {},
    });
    expect(result.delivered).toBe(true);
  });

  test("long message — only first 80 chars used for input-area match", async () => {
    const longMsg = "x".repeat(200);
    const result = await verifySubmitDelivered("sess:0", longMsg, {
      delayMs: 0,
      captureFn: async () => `> ${"x".repeat(80)}`,
      sendKeysFn: async () => {},
      sleepFn: async () => {},
    });
    expect(result.delivered).toBe(false);
    expect(result.retriesNeeded).toBe(2);
  });
});
