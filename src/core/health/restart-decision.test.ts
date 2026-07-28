import { describe, expect, it } from "bun:test";
import { shouldRestart } from "./restart-decision";
import type { ProbeResult } from "./probe";

const ok: ProbeResult = { status: "ok", elapsedMs: 10 };
const slow: ProbeResult = { status: "slow", elapsedMs: 3000 };
const dead: ProbeResult = { status: "dead", elapsedMs: 8000, cause: "timeout" };
const err: ProbeResult = { status: "probe-error", reason: "test fixture" };

describe("kobo-458 shouldRestart — restart only on N consecutive dead, never on a single blip", () => {
  it("all healthy history → never restarts (required negative — avoids restart-storm)", () => {
    const decision = shouldRestart([ok, ok, ok, ok, ok]);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toBe("healthy");
  });

  // F2 (front review): a clean N-1/N boundary pair, isolated from slow/probe-error
  // mixing — before this pair, the threshold's `>=` comparison was only exercised
  // incidentally by tests built for a different purpose (deleting them would leave
  // the boundary itself unguarded).
  it("boundary — exactly N-1 consecutive dead (pure dead run, nothing else mixed in) → does NOT restart", () => {
    const decision = shouldRestart([dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("boundary — exactly N consecutive dead (pure dead run) → restarts, reason names the count", () => {
    const decision = shouldRestart([dead, dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(true);
    expect(decision.reason).toContain("3 consecutive dead");
  });

  it("a single dead blip (well below threshold) → does not restart", () => {
    const decision = shouldRestart([ok, ok, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("a dead streak that recovers (one blip that self-heals, matching the card's own evidence) → does not restart, even if an EARLIER streak once reached the threshold", () => {
    // 3 dead in a row earlier, then it came back — the streak must reset, not
    // accumulate across a recovery, or a server that healed itself an hour
    // ago would still trigger a restart on the next unrelated blip.
    const decision = shouldRestart([dead, dead, dead, ok, ok, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("a slow response breaks a building dead streak — slow must never count toward restart", () => {
    const decision = shouldRestart([dead, dead, slow, dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false); // only 2 consecutive dead at the tail, slow reset it
  });

  it("a probe-error streak alone does NOT restart, but is flagged distinctly — not read as healthy", () => {
    const decision = shouldRestart([ok, err, err, err]);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toContain("WATCHER ERROR");
    expect(decision.reason).not.toBe("healthy");
  });

  it("a probe-error breaks a building dead streak too, same as slow", () => {
    const decision = shouldRestart([dead, dead, err, dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("empty history → does not restart, but reason is NOT 'healthy' — F3, a dead watcher looks identical to a fresh one", () => {
    // A watcher that never ran at all produces the same empty array as one
    // that just started. Reporting "healthy" here would misreport a dead
    // watcher as confirmed-good in exactly the log a human reads during the
    // incident it failed to catch.
    const decision = shouldRestart([]);
    expect(decision.restart).toBe(false);
    expect(decision.reason).not.toBe("healthy");
    expect(decision.reason).toContain("no observations");
  });

  // %5 review at ccac44d, run directly (not read from the code): a threshold
  // of 0 makes `consecutiveDead >= threshold` true unconditionally, so an
  // all-healthy history would restart a server with zero evidence it was
  // ever down. Clamped to 1, never 0 or negative.
  it("threshold configured as 0 → clamps to 1, does NOT restart an all-healthy history", () => {
    const decision = shouldRestart([ok], { consecutiveDeadThreshold: 0 });
    expect(decision.restart).toBe(false);
  });

  it("threshold configured as -5 → clamps to 1, still restarts on a single genuine dead", () => {
    const decision = shouldRestart([dead], { consecutiveDeadThreshold: -5 });
    expect(decision.restart).toBe(true);
  });
});
