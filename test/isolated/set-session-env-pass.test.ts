/**
 * test/isolated/set-session-env-pass.test.ts
 *
 * Unit tests for the pass: secret resolution branch in setSessionEnv()
 * after the defensive refactor (per defensive refactor plan).
 *
 * Strategy:
 *   - Mock concrete transport module (src/core/transport/tmux) to intercept
 *     tmux.setEnvironment calls — same pattern as isolated/wake-cmd.test.ts.
 *   - Mock src/config to control getEnvVars() return value per test.
 *   - Use spyOn(Bun, "spawn") to stub the pass subprocess in Cases 1 & 2,
 *     avoiding a real `pass` binary dependency in CI.
 *   - Case 3 uses a deliberate injection string as the secret name:
 *     Bun.spawn should receive it as a literal argv element (not shell-expanded),
 *     pass CLI will be stubbed to fail (exit 1), and setEnvironment must NOT
 *     be called.
 *
 * Isolated because mock.module is process-global and stubs the tmux transport
 * which is shared across many modules.
 */
import {
  describe, test, expect, mock, spyOn, beforeEach, afterEach,
} from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

// ── src root for consistent mock.module keys ──────────────────────────────────

const srcRoot = join(import.meta.dir, "../..");

// ── Capture tmux real refs BEFORE any mock.module installs ───────────────────
// (following the bun mock.module namespace-replacement pattern documented
//  at the top of isolated/wake-cmd.test.ts)

const _rTmux = await import("../../src/core/transport/tmux");
const realTmux = _rTmux.tmux;

// ── Captured tmux.setEnvironment calls ───────────────────────────────────────

type SetEnvCall = { session: string; key: string; val: string };
let setEnvCalls: SetEnvCall[] = [];

// ── Track current getEnvVars stub value ──────────────────────────────────────

let mockEnvVars: Record<string, string> = {};

// ── Module mocks ─────────────────────────────────────────────────────────────
// Installed before loading the module under test so its import graph resolves
// against our stubs.

mock.module(join(srcRoot, "src/core/transport/tmux"), () => ({
  ..._rTmux,
  tmux: new Proxy({} as typeof realTmux, {
    get(_t, prop: string) {
      if (prop === "then") return undefined; // not a thenable
      return async (...args: unknown[]) => {
        if (prop === "setEnvironment") {
          const [session, key, val] = args as [string, string, string];
          setEnvCalls.push({ session, key, val });
          return;
        }
        return (realTmux as any)[prop]?.(...args);
      };
    },
  }),
}));

mock.module(join(srcRoot, "src/config"), () => ({
  ...mockConfigModule(() => ({ node: "test", agents: {}, env: {} })),
  getEnvVars: () => mockEnvVars,
}));

// ── Load module under test AFTER all mock.module calls ───────────────────────

const { setSessionEnv } = await import("../../src/commands/shared/wake-resolve-impl");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("setSessionEnv — pass: secret resolution (S2 defensive refactor)", () => {
  let spawnSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    setEnvCalls = [];
    spawnSpy = null;
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
  });

  // ── Case 1: Non-pass: branch — direct setEnvironment, no Bun.spawn ──────────

  test("non-pass: value calls tmux.setEnvironment directly without spawning a subprocess", async () => {
    mockEnvVars = { FOO: "bar" };

    // Spy to assert Bun.spawn is NOT called for plain values
    spawnSpy = spyOn(Bun, "spawn");

    await setSessionEnv("mysession");

    expect(setEnvCalls).toHaveLength(1);
    expect(setEnvCalls[0]).toEqual({ session: "mysession", key: "FOO", val: "bar" });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // ── Case 2: pass: branch — Bun.spawn resolves secret, setEnvironment called ─

  test("pass: value spawns pass CLI and passes resolved secret to setEnvironment", async () => {
    mockEnvVars = { SECRET: "pass:test-key" };

    // Stub Bun.spawn to return a fake process that yields "my-resolved-value\n"
    const fakeProc = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("my-resolved-value\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }),
      exited: Promise.resolve(0),
    };

    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc as any);

    await setSessionEnv("mysession");

    // Spawn called with correct argv — no shell, literal name as argv[2]
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as string[];
    expect(spawnArgs).toEqual(["pass", "show", "test-key"]);

    // setEnvironment called with trimmed value (trailing newline stripped)
    expect(setEnvCalls).toHaveLength(1);
    expect(setEnvCalls[0]).toEqual({
      session: "mysession",
      key: "SECRET",
      val: "my-resolved-value",
    });
  });

  // ── Case 3: Injection attempt in secret name is inert ───────────────────────
  //
  // The malicious name "key')&&touch${IFS}/tmp/pwned&&echo '" is passed as a
  // literal string to Bun.spawn argv[2]. No shell expansion occurs. The pass
  // binary receives the literal (malformed) name, fails with non-zero exit, and
  // setEnvironment must NOT be called. An Error must be thrown.

  test("injection attempt in secret name is passed as literal argv element — setEnvironment not called, error thrown", async () => {
    const injectionName = "key')&&touch${IFS}/tmp/pwned&&echo '";
    mockEnvVars = { X: `pass:${injectionName}` };

    // Stub Bun.spawn to simulate pass CLI rejecting the unknown malformed key
    const fakeProc = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Error: key not found\n"));
          controller.close();
        },
      }),
      exited: Promise.resolve(1), // non-zero = failure
    };

    spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc as any);

    let thrown: Error | null = null;
    try {
      await setSessionEnv("mysession");
    } catch (e) {
      thrown = e as Error;
    }

    // Spawn was called with the literal injection string as argv[2]
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0] as string[];
    expect(spawnArgs[0]).toBe("pass");
    expect(spawnArgs[1]).toBe("show");
    expect(spawnArgs[2]).toBe(injectionName); // literal, not shell-expanded

    // setEnvironment was never called
    expect(setEnvCalls).toHaveLength(0);

    // An error was thrown mentioning the failed pass invocation
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/pass show .* failed/);
    expect(thrown!.message).toMatch(/exit 1/);
  });
});
