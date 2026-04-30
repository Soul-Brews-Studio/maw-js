import { describe, test, expect } from "bun:test";
import { cmdTmuxLayout, cmdTmuxSplit, cmdTmuxAttach } from "../../src/commands/plugins/tmux/impl";
import * as impl from "../../src/commands/plugins/tmux/impl";

// Pure-validation tests for split, kill, layout, attach. These verbs call
// hostExec under the hood — we test the input-validation paths that throw
// BEFORE any tmux interaction. Live behavior was smoke-tested in iter 9.

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
    const calls: any[] = [];
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = ((args: any, opts: any) => {
      calls.push({ args, opts });
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    });
    try {
      cmdTmuxAttach("%999", { print: true });
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
    }
    expect(calls).toHaveLength(0); // --print → never spawns
    const joined = logs.join("\n");
    expect(joined).toContain("tmux attach -t");
    expect(joined).toContain("Ctrl-b d");
  });

  test("session-name target with --print → extracts session", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("some-session:0.1", { print: true });
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("tmux attach -t some-session");
  });

  test("no TTY (and no --print) → falls back to 3-line print, no spawn", () => {
    // Simulate non-TTY environment (script / pipe / CI). Bun's test runner
    // typically already has isTTY=undefined, but force it to be safe.
    const origIsTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const calls: any[] = [];
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = ((args: any, opts: any) => {
      calls.push({ args, opts });
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      cmdTmuxAttach("%999"); // no opts → relies on TTY/$TMUX detection
    } finally {
      console.log = origLog;
      (Bun as any).spawnSync = origSpawnSync;
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTty, configurable: true });
      if (origTmux !== undefined) process.env.TMUX = origTmux;
    }

    expect(calls).toHaveLength(0); // no TTY → never spawns
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

    const calls: any[] = [];
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = ((args: any, opts: any) => {
      calls.push({ args, opts });
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    });

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

    const calls: any[] = [];
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = ((args: any, opts: any) => {
      calls.push({ args, opts });
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    });

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

  test("non-zero exit → throws with exit code + verb", () => {
    const origTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => true;
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = (() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      success: false,
    }));

    try {
      expect(() => cmdTmuxAttach("ghost-session")).toThrow(/tmux attach failed.*exit 1/);
    } finally {
      (Bun as any).spawnSync = origSpawnSync;
      impl._tty.isStdoutTTY = origTTY;
      if (origTmux !== undefined) process.env.TMUX = origTmux;
    }
  });

  test("--print overrides TTY detection — never spawns even in interactive shell", () => {
    const origTTY = impl._tty.isStdoutTTY;
    impl._tty.isStdoutTTY = () => true;
    const origTmux = process.env.TMUX;
    delete process.env.TMUX;

    const calls: any[] = [];
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = ((args: any, opts: any) => {
      calls.push({ args, opts });
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), success: true };
    });

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
