import { describe, test, expect } from "bun:test";
import {
  updateStallState,
  formatStallNotice,
  type StallState,
} from "../src/commands/core/tmux/stall-detect";

// Pure logic tests for #976 Phase A stall detection.
// No tmux, no setInterval — `updateStallState` is a pure state-machine
// step, so we feed it captured strings and assert state transitions.

describe("updateStallState — content hash transitions", () => {
  test("first sample initializes state, never reports stall", () => {
    const { state, event } = updateStallState(new Map(), "%1", "hello", 3);
    expect(event).toBeNull();
    expect(state.get("%1")?.unchanged).toBe(1);
    expect(state.get("%1")?.notified).toBe(false);
  });

  test("changed content resets unchanged counter to 1", () => {
    let state: StallState = new Map();
    state = updateStallState(state, "%1", "a", 3).state;
    state = updateStallState(state, "%1", "a", 3).state;
    expect(state.get("%1")?.unchanged).toBe(2);
    const r = updateStallState(state, "%1", "b", 3);
    expect(r.event).toBeNull();
    expect(r.state.get("%1")?.unchanged).toBe(1);
  });

  test("threshold=3 fires stall on third unchanged sample", () => {
    let state: StallState = new Map();
    let last = updateStallState(state, "%1", "x", 3);
    expect(last.event).toBeNull();
    state = last.state;

    last = updateStallState(state, "%1", "x", 3);
    expect(last.event).toBeNull();
    state = last.state;

    last = updateStallState(state, "%1", "x", 3);
    expect(last.event).not.toBeNull();
    expect(last.event?.paneId).toBe("%1");
    expect(last.event?.unchanged).toBe(3);
    expect(last.event?.firstReport).toBe(true);
  });

  test("subsequent unchanged samples set firstReport=false", () => {
    let state: StallState = new Map();
    for (let i = 0; i < 3; i++) {
      state = updateStallState(state, "%1", "x", 3).state;
    }
    // 4th sample — still stalled but already notified
    const r = updateStallState(state, "%1", "x", 3);
    expect(r.event).not.toBeNull();
    expect(r.event?.firstReport).toBe(false);
    expect(r.event?.unchanged).toBe(4);
  });

  test("changed content after stall clears notified flag", () => {
    let state: StallState = new Map();
    for (let i = 0; i < 3; i++) {
      state = updateStallState(state, "%1", "x", 3).state;
    }
    expect(state.get("%1")?.notified).toBe(true);

    // Change → reset
    state = updateStallState(state, "%1", "y", 3).state;
    expect(state.get("%1")?.unchanged).toBe(1);
    expect(state.get("%1")?.notified).toBe(false);

    // Stall again → firstReport=true again
    state = updateStallState(state, "%1", "y", 3).state;
    const final = updateStallState(state, "%1", "y", 3);
    expect(final.event?.firstReport).toBe(true);
  });

  test("multiple panes tracked independently", () => {
    let state: StallState = new Map();
    state = updateStallState(state, "%1", "a", 3).state;
    state = updateStallState(state, "%2", "b", 3).state;
    state = updateStallState(state, "%1", "a", 3).state;
    state = updateStallState(state, "%2", "c", 3).state;  // changed

    expect(state.get("%1")?.unchanged).toBe(2);
    expect(state.get("%2")?.unchanged).toBe(1);
  });

  test("threshold=1 fires on first repeat", () => {
    let state: StallState = new Map();
    state = updateStallState(state, "%1", "x", 1).state;
    const r = updateStallState(state, "%1", "x", 1);
    // unchanged=2 ≥ threshold=1 → stall
    expect(r.event).not.toBeNull();
    expect(r.event?.firstReport).toBe(true);
  });

  test("hash is stable for identical content", () => {
    const r1 = updateStallState(new Map(), "%1", "same content here\nline 2", 3);
    const r2 = updateStallState(new Map(), "%2", "same content here\nline 2", 3);
    expect(r1.state.get("%1")?.hash).toBe(r2.state.get("%2")?.hash);
  });

  test("hash differs for different content", () => {
    const r1 = updateStallState(new Map(), "%1", "alpha", 3);
    const r2 = updateStallState(new Map(), "%1", "beta", 3);
    expect(r1.state.get("%1")?.hash).not.toBe(r2.state.get("%1")?.hash);
  });
});

describe("formatStallNotice — output", () => {
  test("first report uses STALL tag", () => {
    const msg = formatStallNotice(
      { paneId: "%42", hash: "abc123def456", unchanged: 3, firstReport: true },
      30_000,
    );
    expect(msg).toContain("STALL");
    expect(msg).toContain("%42");
    expect(msg).toContain("3 unchanged");
    expect(msg).toContain("abc123de");  // 8-char prefix
    expect(msg).toContain("~90s");      // 3 * 30000 / 1000
  });

  test("subsequent report uses 'still stalled' tag", () => {
    const msg = formatStallNotice(
      { paneId: "%1", hash: "deadbeef00", unchanged: 5, firstReport: false },
      1000,
    );
    expect(msg).toContain("still stalled");
    expect(msg).toContain("~5s");
  });
});
