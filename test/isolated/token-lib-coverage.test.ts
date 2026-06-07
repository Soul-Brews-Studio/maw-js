import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  confirm,
  defaultName,
  detectActiveToken,
  fingerprintTokens,
  listEnvrcNames,
  listTokenNames,
  passExists,
  redact,
  run,
  setRunOverride,
  stripAnsi,
  type RunOptions,
  type RunResult,
} from "../../src/vendor/mpr-plugins/token/lib";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "maw-token-lib-"));

const original = {
  stdoutWrite: process.stdout.write,
  stdinOn: process.stdin.on,
  stdinOnce: process.stdin.once,
  stdinRemoveListener: process.stdin.removeListener,
  stdinResume: process.stdin.resume,
  stdinPause: process.stdin.pause,
  stdinIsTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  spawnSync: Bun.spawnSync,
};

function result(ok: boolean, stdout = "", stderr = "", exitCode = ok ? 0 : 1): RunResult {
  return { ok, stdout, stderr, exitCode };
}

function installFakeTTY() {
  const bus = new EventEmitter();
  const writes: string[] = [];
  let resumed = 0;
  let paused = 0;

  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  (process.stdin as any).on = bus.on.bind(bus);
  (process.stdin as any).once = bus.once.bind(bus);
  (process.stdin as any).removeListener = bus.removeListener.bind(bus);
  (process.stdin as any).resume = (() => {
    resumed += 1;
    return process.stdin;
  }) as typeof process.stdin.resume;
  (process.stdin as any).pause = (() => {
    paused += 1;
    return process.stdin;
  }) as typeof process.stdin.pause;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  return {
    bus,
    writes,
    get resumed() {
      return resumed;
    },
    get paused() {
      return paused;
    },
  };
}

beforeEach(() => {
  setRunOverride(null);
});

afterEach(() => {
  setRunOverride(null);
  process.stdout.write = original.stdoutWrite;
  (process.stdin as any).on = original.stdinOn;
  (process.stdin as any).once = original.stdinOnce;
  (process.stdin as any).removeListener = original.stdinRemoveListener;
  (process.stdin as any).resume = original.stdinResume;
  (process.stdin as any).pause = original.stdinPause;
  (Bun as any).spawnSync = original.spawnSync;
  if (original.stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", original.stdinIsTTY);
  else delete (process.stdin as any).isTTY;
});

describe("token lib coverage", () => {
  test("run passes spawn options through Bun.spawnSync and decodes results", () => {
    const cwd = mkdtempSync(join(TMP_ROOT, "cwd-"));
    const calls: Array<{ cmd: string[]; opts: any }> = [];

    (Bun as any).spawnSync = (cmd: string[], opts: any) => {
      calls.push({ cmd, opts });
      if (cmd[2] === "ok") {
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("stdout-ok"),
          stderr: new TextEncoder().encode("stderr-ok"),
        };
      }
      return {
        exitCode: 7,
        stdout: "plain-out",
        stderr: "plain-err",
      };
    };

    const ok = run(["mock", "--branch", "ok"], {
      cwd,
      env: { FROM_TEST: "env-value" },
      stdin: "hello-from-stdin\n",
    });

    expect(ok).toEqual({
      ok: true,
      exitCode: 0,
      stdout: "stdout-ok",
      stderr: "stderr-ok",
    });

    const fail = run(["mock", "--branch", "fail"]);
    expect(fail).toEqual({ ok: false, exitCode: 7, stdout: "plain-out", stderr: "plain-err" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      cmd: ["mock", "--branch", "ok"],
      opts: {
        cwd,
        env: expect.objectContaining({ FROM_TEST: "env-value" }),
        stdout: "pipe",
        stderr: "pipe",
        stdin: new TextEncoder().encode("hello-from-stdin\n"),
      },
    });
    expect(calls[1]).toEqual({
      cmd: ["mock", "--branch", "fail"],
      opts: {
        cwd: undefined,
        env: expect.any(Object),
        stdout: "pipe",
        stderr: "pipe",
      },
    });
  });

  test("passExists, defaultName, stripAnsi, and redact handle common and edge cases", () => {
    const calls: Array<{ cmd: string[]; opts?: RunOptions }> = [];
    setRunOverride((cmd, opts) => {
      calls.push({ cmd, opts });
      return cmd[2] === "envrc/worked" ? result(true) : result(false, "", "missing", 1);
    });

    expect(passExists("envrc/worked")).toBe(true);
    expect(passExists("envrc/missing")).toBe(false);
    expect(calls.map(c => c.cmd)).toEqual([
      ["pass", "show", "envrc/worked"],
      ["pass", "show", "envrc/missing"],
    ]);

    expect(defaultName("given", "/tmp/ignored")).toBe("given");
    expect(defaultName(undefined, "/tmp/demo///")).toBe("demo");
    expect(defaultName(undefined, "/")).toBe("default");

    expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain");
    expect(redact("alpha secret-value beta secret-value", "secret-value")).toBe(
      "alpha ***REDACTED*** beta ***REDACTED***",
    );
    expect(redact("keep tiny and regex .* chars", "abc", ".*")).toBe("keep tiny and regex .* chars");
  });

  test("detectActiveToken prefers named format, falls back to direct and legacy, and ignores comments", () => {
    expect(detectActiveToken([
      '# export CLAUDE_TOKEN_NAME="commented"',
      'export CLAUDE_TOKEN_NAME="named-token"',
      'export CLAUDE_CODE_OAUTH_TOKEN="$(pass show claude/token-direct-token)"',
    ].join("\n"))).toBe("named-token");

    expect(detectActiveToken([
      '# export CLAUDE_CODE_OAUTH_TOKEN="$(pass show claude/token-commented)"',
      'export CLAUDE_CODE_OAUTH_TOKEN="$(pass show claude/token-direct-token)"',
    ].join("\n"))).toBe("direct-token");

    expect(detectActiveToken([
      'export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_FOO',
      'TOKEN_FOO="$(pass show claude/token-legacy-token)"',
    ].join("\n"))).toBe("legacy-token");

    expect(detectActiveToken('export SOMETHING_ELSE="value"\n# export CLAUDE_TOKEN_NAME="ignored"')).toBeNull();
  });

  test("confirm returns false without a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const writes: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    await expect(confirm("Proceed?")).resolves.toBe(false);
    expect(writes).toEqual([]);
  });

  test("confirm resolves true for y input and false for non-y input", async () => {
    const tty = installFakeTTY();

    const yes = confirm("Proceed?");
    queueMicrotask(() => tty.bus.emit("data", Buffer.from(" y \n")));
    await expect(yes).resolves.toBe(true);
    expect(tty.writes).toEqual(["Proceed? [y/N] "]);
    expect(tty.resumed).toBe(1);
    expect(tty.paused).toBe(1);

    const tty2 = installFakeTTY();
    const no = confirm("Proceed again?");
    queueMicrotask(() => tty2.bus.emit("data", Buffer.from("no\n")));
    await expect(no).resolves.toBe(false);
    expect(tty2.writes).toEqual(["Proceed again? [y/N] "]);
    expect(tty2.resumed).toBe(1);
    expect(tty2.paused).toBe(1);
  });

  test("confirm resolves false on input error or end", async () => {
    const tty = installFakeTTY();
    const errorCase = confirm("Error case?");
    queueMicrotask(() => tty.bus.emit("error", new Error("boom")));
    await expect(errorCase).resolves.toBe(false);

    const tty2 = installFakeTTY();
    const endCase = confirm("End case?");
    queueMicrotask(() => tty2.bus.emit("end"));
    await expect(endCase).resolves.toBe(false);
  });

  test("listTokenNames, listEnvrcNames, and fingerprintTokens parse pass output safely", () => {
    const calls: string[][] = [];
    setRunOverride((cmd) => {
      calls.push(cmd);
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "claude") {
        return result(true, [
          "Password Store",
          "\u001b[32m├── token-alpha\u001b[0m",
          "└── token-beta",
        ].join("\n"));
      }
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "envrc") {
        return result(true, [
          "Password Store",
          "envrc/",
          "  foo",
          "  bar  ",
          " nested/",
        ].join("\n"));
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-alpha") {
        return result(true, "12345678-secret\n");
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-beta") {
        return result(true, "short\n");
      }
      return result(false, "", "unexpected", 1);
    });

    expect(listTokenNames()).toEqual(["alpha", "beta"]);
    expect(listEnvrcNames()).toEqual(["foo", "bar"]);

    const fingerprints = fingerprintTokens();
    expect([...fingerprints.entries()]).toEqual([["12345678-secret", "alpha"]]);
    expect(calls).toEqual([
      ["pass", "ls", "claude"],
      ["pass", "ls", "envrc"],
      ["pass", "ls", "claude"],
      ["pass", "show", "claude/token-alpha"],
      ["pass", "show", "claude/token-beta"],
    ]);
  });

  test("list helpers fail soft when pass commands fail", () => {
    setRunOverride((cmd) => {
      if (cmd[0] === "pass" && cmd[1] === "ls") return result(false, "", "no vault", 1);
      return result(false, "", "missing", 1);
    });

    expect(listTokenNames()).toEqual([]);
    expect(listEnvrcNames()).toEqual([]);
    expect(fingerprintTokens()).toEqual(new Map());
  });
});
