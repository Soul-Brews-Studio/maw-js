import { describe, test, expect } from "bun:test";
import { cmdTmuxLayout, cmdTmuxSplit, cmdTmuxAttach, _sendTracker } from "../../src/commands/core/tmux/impl";
import * as impl from "../../src/commands/core/tmux/impl";
import { readFileSync } from "fs";
import { join } from "path";

const implSrc = readFileSync(join(import.meta.dir, "../../src/commands/core/tmux/impl.ts"), "utf-8");

// Pure-validation tests for split, kill, layout, attach. These verbs call
// hostExec under the hood — we test the input-validation paths that throw
// BEFORE any tmux interaction. Live behavior was smoke-tested in iter 9.

// ── helpers ─────────────────────────────────────────────────────────────────
// cmdTmuxAttach pre-flights `tmux list-sessions` via Bun.spawnSync and bails
// to suggestRecovery() (→ process.exit) if the session isn't alive. The
// helpers below provide a smart spawnSync mock that:
//   - intercepts `tmux list-sessions` and returns the configured alive list
//   - records all OTHER spawns into `calls` for assertion
// And a process.exit stub that throws a sentinel instead of killing the
// test runner — used when we expect suggestRecovery() to be triggered.

function makeSpawnSyncMock(opts: {
  alive?: string[];
  result?: { exitCode: number; success: boolean };
} = {}) {
  const calls: Array<{ args: any; opts: any }> = [];
  const alive = opts.alive ?? [];
  const result = opts.result ?? { exitCode: 0, success: true };
  const mock = (args: any, options: any) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(alive.join("\n")),
        stderr: new Uint8Array(),
        success: true,
      };
    }
    calls.push({ args, opts: options });
    return {
      exitCode: result.exitCode,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      success: result.success,
    };
  };
  return { mock, calls };
}

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}
function stubProcessExit(): { restore: () => void; calls: number[] } {
  const orig = process.exit;
  const calls: number[] = [];
  (process as any).exit = (code?: number) => {
    const c = code ?? 0;
    calls.push(c);
    throw new ExitCalled(c);
  };
  return { restore: () => { (process as any).exit = orig; }, calls };
}

describe("cmdTmuxLayout — input validation", () => {
  test("invalid preset → throws", async () => {
    await expect(cmdTmuxLayout("any-target", "weird-layout")).rejects.toThrow(/invalid layout/);
  });

  test("error message lists all valid presets", async () => {
    try {
      await cmdTmuxLayout("any-target", "bogus");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("even-horizontal");
      expect(e.message).toContain("tiled");
      expect(e.message).toContain("main-horizontal");
    }
  });
});

describe("cmdTmuxSplit — pct bounds", () => {
  test("pct 0 → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: 0 })).rejects.toThrow(/pct must be 1-99/);
  });

  test("pct 100 → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: 100 })).rejects.toThrow(/pct must be 1-99/);
  });

  test("pct -5 → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: -5 })).rejects.toThrow(/pct must be 1-99/);
  });

  test("pct NaN → throws", async () => {
    await expect(cmdTmuxSplit("any:0.0", { pct: NaN })).rejects.toThrow(/pct must be 1-99/);
  });
});

describe("cmdTmuxAttach — print fallback (no TTY / --print)", () => {
  test("--print resolves and prints attach command (no exec)", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    // Pre-flight session-aliveness: report "%999" alive so we don't fall to recovery.
    const { mock, calls } = makeSpawnSyncMock({ alive: ["%999"] });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;
    try {
      cmdTmuxAttach("%999", { print: true });
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
    }
    expect(calls).toHaveLength(0); // --print → never spawns (list-sessions is filtered)
    const joined = logs.join("\n");
    expect(joined).toContain("tmux attach -t");
    expect(joined).toContain("Ctrl-b d");
  });

  test("session-name target with --print → extracts session", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    const { mock } = makeSpawnSyncMock({ alive: ["some-session"] });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;
    try {
      cmdTmuxAttach("some-session:0.1", { print: true });
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
    }
    expect(logs.join("\n")).toContain("tmux attach -t some-session");
  });

  test("no TTY (and no --print) → falls back to 3-line print, no spawn", () => {
    // Simulate non-TTY environment (script / pipe / CI).
    const origIsTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const origTmuxTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => false;
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const { mock, calls } = makeSpawnSyncMock({ alive: ["%999"] });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("%999"); // no opts → relies on TTY/$TMUX detection
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
      impl._tty.isStdoutTTY = origTmuxTTY;
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTty, configurable: true });
      if (origTmux !== undefined) process.env.TMUX = origTmux;
    }

    expect(calls).toHaveLength(0); // no TTY → never spawns (list-sessions is filtered)
    const joined = logs.join("\n");
    expect(joined).toContain("tmux attach -t");
    expect(joined).toContain("Ctrl-b d");
  });
});

describe("cmdTmuxAttach — TTY exec branches", () => {
  test("inside tmux + TTY → spawns `tmux switch-client -t <session>`", () => {
    const origTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => true;
    const origTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";

    const { mock, calls } = makeSpawnSyncMock({ alive: ["some-session"] });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("some-session:0.1");
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
      impl._tty.isStdoutTTY = origTTY;
      if (origTmux !== undefined) process.env.TMUX = origTmux;
      else delete process.env.TMUX;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["tmux", "switch-client", "-t", "some-session"]);
    expect(logs.join("\n")).not.toContain("Run: tmux attach -t");
  });

  test("outside tmux + TTY → spawns `tmux attach -t <session>`", () => {
    const origTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => true;
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const { mock, calls } = makeSpawnSyncMock({ alive: ["some-session"] });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;

    try {
      cmdTmuxAttach("some-session:0.1");
    } finally {
      (Bun as any).spawnSync = origSpawnSync;
      impl._tty.isStdoutTTY = origTTY;
      if (origTmux !== undefined) process.env.TMUX = origTmux;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["tmux", "attach", "-t", "some-session"]);
  });

  test("non-zero exit → triggers suggestRecovery (process.exit)", () => {
    // Pre-#1061 this threw `tmux attach failed: exit 1`. Smart-recovery now
    // calls suggestRecovery() → process.exit (or maw wake auto-spawn). We
    // assert the new behavior by stubbing process.exit so it throws instead
    // of killing the test runner.
    const origTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => true;
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const { mock } = makeSpawnSyncMock({
      alive: ["ghost-session"],
      result: { exitCode: 1, success: false }, // attach (and any maw-wake follow-up) → fail
    });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;

    const exitStub = stubProcessExit();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));

    let threw: unknown = null;
    try {
      try {
        cmdTmuxAttach("ghost-session");
      } catch (e) {
        threw = e;
      }
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
      impl._tty.isStdoutTTY = origTTY;
      exitStub.restore();
      if (origTmux !== undefined) process.env.TMUX = origTmux;
    }

    // suggestRecovery either calls process.exit directly or after maw-wake
    // auto-spawn — either way process.exit must have fired.
    expect(exitStub.calls.length).toBeGreaterThan(0);
    expect(threw).toBeInstanceOf(ExitCalled);
  });

  test("--print overrides TTY detection — never spawns even in interactive shell", () => {
    const origTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => true;
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const { mock, calls } = makeSpawnSyncMock({ alive: ["%999"] });
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = mock;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("%999", { print: true });
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
      impl._tty.isStdoutTTY = origTTY;
      if (origTmux !== undefined) process.env.TMUX = origTmux;
    }

    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("tmux attach -t");
  });
});

// ── Heartbeat #974: Cooldown + Quota Gating ──────────────────────────────────

describe("cmdTmuxSend — cooldown + quota (Heartbeat #974)", () => {
  test("_sendTracker is exported and is a Map", () => {
    expect(_sendTracker).toBeInstanceOf(Map);
  });

  test("Gate 0 exists in cmdTmuxSend before Gate 1", () => {
    const gate0 = implSrc.indexOf("Gate 0");
    const gate1 = implSrc.indexOf("Gate 1");
    expect(gate0).toBeGreaterThan(-1);
    expect(gate1).toBeGreaterThan(gate0);
  });

  test("cooldown check uses _sendTracker.get(resolved)", () => {
    expect(implSrc).toMatch(/_sendTracker\.get\(resolved\)/);
  });

  test("cooldown is bypassed by opts.force", () => {
    expect(implSrc).toMatch(/if\s*\(\s*!opts\.force\s*\)\s*\{[\s\S]*?_sendTracker/);
  });

  test("COOLDOWN_MS and QUOTA_PER_MINUTE constants exist", () => {
    expect(implSrc).toMatch(/const COOLDOWN_MS\s*=\s*\d+/);
    expect(implSrc).toMatch(/const QUOTA_PER_MINUTE\s*=\s*\d+/);
    expect(implSrc).toMatch(/const QUOTA_WINDOW_MS\s*=\s*\d+/);
  });

  test("quota resets when window expires", () => {
    expect(implSrc).toMatch(/prev\.windowStart\s*>\s*QUOTA_WINDOW_MS/);
    expect(implSrc).toMatch(/prev\.count\s*=\s*0/);
  });

  test("tracker map can be manipulated directly", () => {
    _sendTracker.clear();
    _sendTracker.set("test-pane", { lastTs: Date.now(), count: 50, windowStart: Date.now() });
    expect(_sendTracker.get("test-pane")?.count).toBe(50);
    _sendTracker.clear();
  });
});
