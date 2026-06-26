/**
 * dispatch-engine-input-guard.test.ts — eq3-003 pane-input guard delivery paths.
 *
 * Covers the zero-overtype contract across flush / sweep / stall-notify /
 * indicator, with the pane-idle + indicator + sendKeys seams injected:
 *   flush-drains-when-clean   · flush-skips-when-dirty
 *   sweep-delivers-when-cleared · sweep-skips-when-dirty
 *   notify-fires-once-on-stall · indicator set/clear
 *
 * api/feed is mocked so stall Notification events are captured in-process.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { join } from "path";

let feedEvents: any[] = [];

mock.module(join(import.meta.dir, "../../src/api/feed"), () => ({
  pushFeedEvent: (e: any) => { feedEvents.push(e); },
}));

const { DispatchEngine } = await import("../../src/core/dispatch-engine");
const { messageQueue } = await import("../../src/core/message-queue");

const TARGET = "sess:neo.0";

function enqueue(message: string, oracle = "neo", target = TARGET) {
  return messageQueue.enqueue({ from: "node:sender", to: oracle, target, message });
}

function makeEngine(opts: {
  stallThresholdMs?: number;
  detectMenu?: (target: string) => Promise<boolean>;
  resolveSenderTarget?: (from: string) => Promise<{ oracle: string; target: string } | null>;
} = {}) {
  const sendKeysCalls: Array<{ target: string; text: string }> = [];
  const indicatorCalls: Array<{ target: string; count: number }> = [];
  // Per-target idle state — default idle:true for any unset target.
  const idleByTarget = new Map<string, boolean>();
  const engine = new DispatchEngine(
    async (target: string, text: string) => { sendKeysCalls.push({ target, text }); },
    {
      paneIdle: async (target: string) => idleByTarget.get(target) ?? true,
      setIndicator: async (target: string, count: number) => { indicatorCalls.push({ target, count }); },
      stallThresholdMs: opts.stallThresholdMs ?? 180_000,
      detectMenu: opts.detectMenu,
      resolveSenderTarget: opts.resolveSenderTarget,
    },
  );
  return {
    engine, sendKeysCalls, indicatorCalls,
    setIdle: (v: boolean, target: string = TARGET) => { idleByTarget.set(target, v); },
  };
}

beforeEach(() => {
  // Clear the shared singleton between cases (prune with zero ages drops everything).
  messageQueue.prune(0, 0);
  feedEvents = [];
});

describe("flush — drain vs defer", () => {
  test("flush-drains-when-clean: delivers all pending, clears the badge", async () => {
    enqueue("m1"); enqueue("m2");
    const { engine, sendKeysCalls, indicatorCalls } = makeEngine();
    const res = await engine.flush("neo");
    expect(res.delivered).toBe(2);
    expect(res.deferred).toBe(0);
    expect(res.remaining).toBe(0);
    expect(sendKeysCalls.map(c => c.text)).toEqual(["m1", "m2"]);
    expect(indicatorCalls.at(-1)).toEqual({ target: TARGET, count: 0 });
  });

  test("flush-skips-when-dirty: zero injection, keeps the queue + shows the count", async () => {
    enqueue("m1");
    const { engine, sendKeysCalls, indicatorCalls, setIdle } = makeEngine();
    setIdle(false);
    const res = await engine.flush("neo");
    expect(res.delivered).toBe(0);
    expect(res.deferred).toBe(1);
    expect(res.remaining).toBe(1);
    expect(sendKeysCalls.length).toBe(0);
    expect(messageQueue.pending("neo").length).toBe(1);
    expect(indicatorCalls.at(-1)).toEqual({ target: TARGET, count: 1 });
  });

  test("flush is idempotent on an already-drained queue", async () => {
    enqueue("m1");
    const { engine, sendKeysCalls } = makeEngine();
    await engine.flush("neo");
    const res = await engine.flush("neo");
    expect(res.delivered).toBe(0);
    expect(res.remaining).toBe(0);
    expect(sendKeysCalls.length).toBe(1); // delivered exactly once
  });
});

describe("sweep — hook-independent net", () => {
  test("sweep-skips-when-dirty: nothing delivered while the operator keeps typing", async () => {
    enqueue("m1");
    const { engine, sendKeysCalls, setIdle } = makeEngine();
    setIdle(false);
    await engine.runSweepOnce();
    await engine.runSweepOnce();
    expect(sendKeysCalls.length).toBe(0);
    expect(messageQueue.pending("neo").length).toBe(1);
  });

  test("sweep-delivers-when-cleared: delivers itself once input clears (no hook needed)", async () => {
    enqueue("m1");
    const { engine, sendKeysCalls, setIdle } = makeEngine();
    setIdle(false);
    await engine.runSweepOnce();          // dirty — held
    expect(sendKeysCalls.length).toBe(0);
    setIdle(true);
    await engine.runSweepOnce();          // cleared (not submitted) — delivered
    expect(sendKeysCalls.map(c => c.text)).toEqual(["m1"]);
    expect(messageQueue.pending("neo").length).toBe(0);
  });
});

describe("stall notify — last-resort, never overtype", () => {
  test("notify-fires-once-on-stall: one Notification for a message stuck past threshold", async () => {
    const msg = enqueue("m1");
    // Age the message well past the threshold.
    const entry = messageQueue.getAll().find(m => m.id === msg.id)!;
    entry.queuedAt = entry.queuedAt - 1_000_000;
    const { engine, sendKeysCalls, setIdle } = makeEngine({ stallThresholdMs: 1000 });
    setIdle(false); // operator never stops typing

    await engine.runSweepOnce();
    await engine.runSweepOnce();
    await engine.runSweepOnce();

    const stalls = feedEvents.filter(e => e?.data?.kind === "dispatch-stall");
    expect(stalls.length).toBe(1);
    expect(stalls[0].event).toBe("Notification");
    expect(stalls[0].data.oracle).toBe("neo");
    // Crucially: still never overtyped.
    expect(sendKeysCalls.length).toBe(0);
    expect(messageQueue.pending("neo").length).toBe(1);
  });
});

describe("stall notify → sender (eq3-004)", () => {
  const SENDER = "sess:sender.0";

  test("menu-immediate: a permission modal pings the sender at once, no threshold wait", async () => {
    enqueue("m1"); // from "node:sender"
    const { engine, sendKeysCalls, setIdle } = makeEngine({
      stallThresholdMs: 180_000,              // far away — proves we did NOT wait it out
      detectMenu: async (t) => t === TARGET,  // recipient pane shows a modal
      resolveSenderTarget: async () => ({ oracle: "sender", target: SENDER }),
    });
    setIdle(false, TARGET);                   // the modal row reads as "typing" → never overtype it

    await engine.runSweepOnce();

    // Recipient never overtyped while the modal is up.
    expect(sendKeysCalls.find(c => c.target === TARGET)).toBeUndefined();
    // Sender pinged immediately, with the menu reason.
    const ping = sendKeysCalls.find(c => c.target === SENDER);
    expect(ping).toBeDefined();
    expect(ping!.text).toContain("deliver ไม่ได้");
    expect(ping!.text).toContain("permission prompt");

    // One-shot — a second sweep does not re-ping.
    await engine.runSweepOnce();
    expect(sendKeysCalls.filter(c => c.target === SENDER).length).toBe(1);
  });

  test("stall-to-sender: a non-menu stall past threshold pings the sender once (feed event too)", async () => {
    const msg = enqueue("m1");
    const entry = messageQueue.getAll().find(m => m.id === msg.id)!;
    entry.queuedAt -= 1_000_000;              // age past the threshold
    const { engine, sendKeysCalls, setIdle } = makeEngine({
      stallThresholdMs: 1000,
      detectMenu: async () => false,          // plain stall, not a modal
      resolveSenderTarget: async () => ({ oracle: "sender", target: SENDER }),
    });
    setIdle(false, TARGET);                   // operator keeps typing on the recipient

    await engine.runSweepOnce();
    await engine.runSweepOnce();

    const pings = sendKeysCalls.filter(c => c.target === SENDER);
    expect(pings.length).toBe(1);
    expect(pings[0].text).toContain("operator input");
    expect(sendKeysCalls.find(c => c.target === TARGET)).toBeUndefined();   // never overtyped
    expect(feedEvents.filter(e => e?.data?.kind === "dispatch-stall").length).toBe(1);
  });

  test("no-overtype-sender: a busy sender pane holds the ping in queue (zero injection)", async () => {
    const msg = enqueue("m1");
    const entry = messageQueue.getAll().find(m => m.id === msg.id)!;
    entry.queuedAt -= 1_000_000;
    const { engine, sendKeysCalls, setIdle } = makeEngine({
      stallThresholdMs: 1000,
      resolveSenderTarget: async () => ({ oracle: "sender", target: SENDER }),
    });
    setIdle(false, TARGET);                   // recipient dirty
    setIdle(false, SENDER);                   // sender ALSO mid-typing → must not overtype

    await engine.runSweepOnce();
    // Ping enqueued but held — the sender is typing.
    expect(sendKeysCalls.find(c => c.target === SENDER)).toBeUndefined();
    expect(messageQueue.pending("sender").length).toBe(1);

    // Once the sender clears, the sweep delivers the held ping (no re-trigger needed).
    setIdle(true, SENDER);
    await engine.runSweepOnce();
    expect(sendKeysCalls.find(c => c.target === SENDER)).toBeDefined();
    expect(messageQueue.pending("sender").length).toBe(0);
  });
});

describe("indicator — 📬 badge lifecycle", () => {
  test("badge appears with the count, then clears to 0 after drain", async () => {
    enqueue("m1");
    const { engine, indicatorCalls, setIdle } = makeEngine();
    setIdle(false);
    await engine.flush("neo");            // dirty → count 1
    setIdle(true);
    await engine.flush("neo");            // clean → drained → count 0
    const counts = indicatorCalls.filter(c => c.target === TARGET).map(c => c.count);
    expect(counts).toContain(1);
    expect(counts.at(-1)).toBe(0);
  });
});
