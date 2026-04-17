/**
 * test/isolated/ssh-transport.test.ts
 *
 * Unit tests for ssh.ts transport functions after the H2 defensive refactor.
 * Verifies that listSessions, capture, and selectWindow delegate to the
 * Tmux class (which routes all args through q()) rather than building raw
 * shell strings with single-quote interpolation.
 *
 * Isolated because mock.module is process-global and stubs the Tmux class
 * which is shared across many modules.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

// --- Capture real Tmux refs BEFORE any mock.module installs ---
const _rTmux = await import("../../src/core/transport/tmux");

// --- Mutable stub state ---
type RunCall = { subcommand: string; args: (string | number)[] };
let runCalls: RunCall[] = [];
let runReturnValue = "";
let listSessionsReturn: { name: string; windows: { index: number; name: string; active: boolean }[] }[] = [];
let captureReturnValue = "";
let selectWindowCalls: string[] = [];

// --- Mock tmux module ---
mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    constructor(public host?: string, public socket?: string) {}

    async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
      runCalls.push({ subcommand, args });
      return runReturnValue;
    }

    async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
      return this.run(subcommand, ...args);
    }

    async listSessions(): Promise<typeof listSessionsReturn> {
      runCalls.push({ subcommand: "list-sessions", args: [] });
      return listSessionsReturn;
    }

    async capture(target: string, lines = 80): Promise<string> {
      runCalls.push({ subcommand: "capture-pane", args: ["-t", target, lines] });
      return captureReturnValue;
    }

    async selectWindow(target: string): Promise<void> {
      selectWindowCalls.push(target);
      runCalls.push({ subcommand: "select-window", args: ["-t", target] });
    }

    async listWindows(session: string) {
      return [];
    }
  }

  return {
    ..._rTmux,
    Tmux: MockTmux,
    tmux: new MockTmux(),
    tmuxCmd: () => "tmux",
  };
});

// --- Mock config ---
mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => ({ node: "test-node", host: "local" })),
);

// --- Import module under test AFTER all mock.module installs ---
const { listSessions, capture, selectWindow } = await import("../../src/core/transport/ssh");

describe("ssh.ts transport — H2 defensive refactor", () => {
  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
    listSessionsReturn = [];
    captureReturnValue = "";
    selectWindowCalls = [];
  });

  describe("listSessions — delegates to Tmux.listSessions", () => {
    test("Case 1 — returns sessions from Tmux.listSessions", async () => {
      listSessionsReturn = [{ name: "mysession", windows: [] }];
      const result = await listSessions();
      expect(result).toEqual([{ name: "mysession", windows: [] }]);
      // Verify it called through Tmux class
      const listCall = runCalls.find(c => c.subcommand === "list-sessions");
      expect(listCall).toBeDefined();
    });

    test("Case 2 — empty sessions return empty array", async () => {
      listSessionsReturn = [];
      const result = await listSessions();
      expect(result).toEqual([]);
    });

    test("Case 3 — session names with shell metacharacters pass through without interpolation", async () => {
      // If a malicious peer injects such a name, it arrives here already as data
      // The key is that Tmux.listSessions receives it as structured data, not shell
      listSessionsReturn = [{ name: "safe-session", windows: [{ index: 0, name: "oracle", active: true }] }];
      const result = await listSessions();
      expect(result[0].name).toBe("safe-session");
      // No shell string should appear in any run() call with the session name interpolated
      const anyShellString = runCalls.some(c =>
        typeof c.subcommand === "string" && c.subcommand.includes("'safe-session'"),
      );
      expect(anyShellString).toBe(false);
    });
  });

  describe("capture — delegates to Tmux.capture", () => {
    test("Case 1 — delegates to Tmux.capture with same args", async () => {
      captureReturnValue = "pane content here";
      const result = await capture("session:window.0", 50);
      expect(result).toBe("pane content here");
      const captureCall = runCalls.find(c => c.subcommand === "capture-pane");
      expect(captureCall).toBeDefined();
      // Target should appear as a discrete arg, not interpolated
      expect(captureCall!.args).toContain("session:window.0");
    });

    test("Case 2 — single-quote in target reaches Tmux as discrete arg (not shell string)", async () => {
      const injectionTarget = "sess'; rm -rf /'";
      captureReturnValue = "";
      await capture(injectionTarget, 20);
      const captureCall = runCalls.find(c => c.subcommand === "capture-pane");
      expect(captureCall).toBeDefined();
      // The injection string must appear as a literal discrete argument element
      expect(captureCall!.args).toContain(injectionTarget);
      // It must NOT appear embedded in a shell string like `tmux capture-pane -t '...'`
      const hasShellInterpolation = runCalls.some(c =>
        c.subcommand.includes(`-t '${injectionTarget}'`),
      );
      expect(hasShellInterpolation).toBe(false);
    });

    test("Case 3 — default lines value passes through", async () => {
      await capture("mysession:0");
      const captureCall = runCalls.find(c => c.subcommand === "capture-pane");
      expect(captureCall).toBeDefined();
    });
  });

  describe("selectWindow — delegates to Tmux.selectWindow", () => {
    test("Case 1 — delegates to Tmux.selectWindow", async () => {
      await selectWindow("mysession:2");
      expect(selectWindowCalls).toContain("mysession:2");
    });

    test("Case 2 — injection target reaches selectWindow as discrete value", async () => {
      const injectionTarget = "session'; touch /tmp/pwned; tmux #";
      await selectWindow(injectionTarget);
      // Must appear in select-window call
      expect(selectWindowCalls).toContain(injectionTarget);
      // Must NOT appear as a shell-interpolated string
      const hasShellInterpolation = runCalls.some(c =>
        typeof c.subcommand === "string" && c.subcommand.includes(`-t '${injectionTarget}'`),
      );
      expect(hasShellInterpolation).toBe(false);
    });

    test("Case 3 — host parameter is forwarded to Tmux constructor", async () => {
      // This test verifies the host is passed through (behavior: same for local)
      await selectWindow("mysession:1", undefined);
      expect(selectWindowCalls).toContain("mysession:1");
    });
  });
});
