/**
 * #549 — `maw a <target>` should offer to wake when session missing.
 *
 * Pure-unit tests for decideWakePrompt + the prompt+wake hand-off in cmdView.
 * No tmux/sdk involved — we exercise the not-found branch by passing an agent
 * name guaranteed to miss in an empty session list, with stub ask/wakeImpl.
 */
import { describe, it, expect, mock } from "bun:test";
import { cmdView, decideWakePrompt } from "../src/commands/plugins/view/impl";

// listSessions returns whatever tmux reports; in test env no tmux server is
// running so the call returns an empty list. That's exactly the not-found
// path we want to exercise. If the test env ever changes, the impossibly
// random agent name keeps the resolver in `none`.
const MISS = "no-such-oracle-zzzz-549";

describe("#549 decideWakePrompt — decision matrix", () => {
  it("--no-wake always skips, even in TTY", () => {
    expect(decideWakePrompt({ isTTY: true, noWake: true })).toBe("skip");
    expect(decideWakePrompt({ isTTY: false, noWake: true })).toBe("skip");
  });

  it("--wake always forces, no prompt", () => {
    expect(decideWakePrompt({ isTTY: true, wake: true })).toBe("force");
    expect(decideWakePrompt({ isTTY: false, wake: true })).toBe("force");
  });

  it("non-TTY without flags = skip (back-compat for CI/scripts)", () => {
    expect(decideWakePrompt({ isTTY: false })).toBe("skip");
  });

  it("TTY without flags = ask", () => {
    expect(decideWakePrompt({ isTTY: true })).toBe("ask");
  });

  it("--no-wake wins over --wake (explicit deny beats explicit allow)", () => {
    expect(decideWakePrompt({ isTTY: true, wake: true, noWake: true })).toBe("skip");
  });
});

describe("#549 cmdView — TTY prompt → wake hand-off", () => {
  it("yes answer triggers wakeImpl with the requested target", async () => {
    const wakeImpl = mock(async (_t: string) => {});
    const ask = mock(async (_q: string) => "y");

    await cmdView(MISS, undefined, false, false, undefined, {
      wake: true, // bypass TTY detection — force = wake without ask
      ask,
      wakeImpl,
    });

    expect(wakeImpl).toHaveBeenCalledTimes(1);
    expect(wakeImpl.mock.calls[0]![0]).toBe(MISS);
    // force path doesn't ask
    expect(ask).not.toHaveBeenCalled();
  });

  it("ask=yes path: ask is called, then wake is called, no error thrown", async () => {
    const wakeImpl = mock(async (_t: string) => {});
    const ask = mock(async (_q: string) => "yes");

    // Use the opts-object overload to inject ask without depending on isTTY.
    // We feed wake=false, noWake=false, but stub ask — decideWakePrompt
    // returns "ask" only when isTTY is true. Since we can't reliably set
    // process.stdin.isTTY in bun:test, we go through the --wake path for
    // the success case and exercise the ask-prompt code path via a helper
    // that exposes the prompt branch directly.
    //
    // To still cover the ask code path end-to-end, we monkey-patch
    // process.stdin.isTTY for the duration of the call.
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await cmdView(MISS, { ask, wakeImpl });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(wakeImpl).toHaveBeenCalledTimes(1);
      expect(wakeImpl.mock.calls[0]![0]).toBe(MISS);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });

  it("ask=no path: ask is called, wake is NOT called, original error thrown", async () => {
    const wakeImpl = mock(async (_t: string) => {});
    const ask = mock(async (_q: string) => "n");

    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await expect(cmdView(MISS, { ask, wakeImpl })).rejects.toThrow(/session not found/);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(wakeImpl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });

  it("non-TTY (default) path: no prompt, original error thrown — back-compat", async () => {
    const wakeImpl = mock(async (_t: string) => {});
    const ask = mock(async (_q: string) => "y");

    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(cmdView(MISS, { ask, wakeImpl })).rejects.toThrow(/session not found/);
      expect(ask).not.toHaveBeenCalled();
      expect(wakeImpl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });

  it("--no-wake in a TTY: no prompt, original error thrown", async () => {
    const wakeImpl = mock(async (_t: string) => {});
    const ask = mock(async (_q: string) => "y");

    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await expect(
        cmdView(MISS, { ask, wakeImpl, noWake: true }),
      ).rejects.toThrow(/session not found/);
      expect(ask).not.toHaveBeenCalled();
      expect(wakeImpl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
    }
  });
});
