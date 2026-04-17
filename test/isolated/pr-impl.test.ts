/**
 * test/isolated/pr-impl.test.ts
 *
 * Unit tests for cmdPr() after the H6 defensive refactor.
 * Verifies that tmux display-message calls are routed through Tmux.run
 * (arg-array, q()-escaped) and that git/gh subprocesses use Bun.spawn
 * arg-arrays rather than shell-interpolated strings.
 *
 * Isolated because mock.module is process-global and stubs the Tmux class
 * and Bun.spawn.
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

// --- Capture real Tmux refs BEFORE any mock.module installs ---
const _rTmux = await import("../../src/core/transport/tmux");

// --- Mutable stub state ---
type RunCall = { subcommand: string; args: (string | number)[] };
let runCalls: RunCall[] = [];
let runResponses: Map<string, string> = new Map();

// --- Mock tmux module ---
mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    constructor(public host?: string, public socket?: string) {}

    async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
      runCalls.push({ subcommand, args });
      // Key by subcommand + first few args for routing
      const key = [subcommand, ...args].join(" ");
      for (const [pattern, val] of runResponses) {
        if (key.includes(pattern)) return val;
      }
      return "";
    }

    async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
      return this.run(subcommand, ...args);
    }
  }

  return {
    ..._rTmux,
    Tmux: MockTmux,
    tmux: new MockTmux(),
  };
});

// --- Mock config ---
mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => ({ node: "test-node" })),
);

// --- Bun.spawn spy setup ---
type SpawnCall = { cmd: string[]; opts?: Record<string, unknown> };
let spawnCalls: SpawnCall[] = [];

// --- Import module under test AFTER all mock.module installs ---
const { cmdPr } = await import("../../src/commands/plugins/pr/impl");

// --- Helper to make a mock spawn proc ---
function makeMockProc(stdout: string, exitCode = 0) {
  const enc = new TextEncoder();
  const rs = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(stdout));
      controller.close();
    },
  });
  const errRs = new ReadableStream({ start(c) { c.close(); } });
  return {
    stdout: rs,
    stderr: errRs,
    exited: Promise.resolve(exitCode),
  };
}

describe("cmdPr — H6 defensive refactor", () => {
  const origTmux = process.env.TMUX;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    runCalls = [];
    spawnCalls = [];
    runResponses = new Map();
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";

    // Spy on Bun.spawn to capture calls without actually spawning processes
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, opts?: any) => {
      spawnCalls.push({ cmd: Array.isArray(cmd) ? cmd : [cmd], opts });
      const cmdStr = Array.isArray(cmd) ? cmd[0] : cmd;
      // Return appropriate mock proc based on command
      if (cmdStr === "git") return makeMockProc("feat/issue-42\n") as any;
      if (cmdStr === "gh") return makeMockProc("https://github.com/org/repo/pull/99\n") as any;
      return makeMockProc("") as any;
    });
  });

  afterEach(() => {
    if (origTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = origTmux;
    spawnSpy.mockRestore();
  });

  test("Case 1 — cmdPr without window: uses current pane path via Tmux.run", async () => {
    // Setup: display-message -p #{pane_current_path} → /home/neo/repos/maw-js
    runResponses.set("display-message", "/home/neo/repos/maw-js");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      await cmdPr();
    } finally {
      console.log = origLog;
    }

    // Tmux.run must have been called with display-message args (no window)
    const displayCall = runCalls.find(c => c.subcommand === "display-message");
    expect(displayCall).toBeDefined();
    expect(displayCall!.args).toContain("#{pane_current_path}");

    // git spawn should have been called with cwd as a separate arg (not in shell string)
    const gitCall = spawnCalls.find(c => c.cmd[0] === "git");
    expect(gitCall).toBeDefined();
    expect(gitCall!.cmd).toEqual(["git", "-C", "/home/neo/repos/maw-js", "branch", "--show-current"]);
    expect(gitCall!.opts?.cwd).toBeUndefined(); // cwd is passed as -C arg, not spawn option

    // gh spawn should use cwd option instead of cd-in-shell
    const ghCall = spawnCalls.find(c => c.cmd[0] === "gh");
    expect(ghCall).toBeDefined();
    expect(ghCall!.opts?.cwd).toBe("/home/neo/repos/maw-js");
    expect(ghCall!.cmd).toContain("--title");
    // gh cmd must NOT contain any single-quote shell quoting
    const hasShellQuotes = ghCall!.cmd.some(a => typeof a === "string" && a.includes("'"));
    expect(hasShellQuotes).toBe(false);

    // Should have logged success
    expect(logs.some(l => l.includes("✅"))).toBe(true);
  });

  test("Case 2 — single quote in window name reaches Tmux.run as separate argv", async () => {
    // Setup two display-message calls: one for session_name, one for pane_current_path
    let runCallIndex = 0;
    const _rTmuxAgain = await import("../../src/core/transport/tmux");
    const MockTmuxClass = _rTmuxAgain.Tmux as any;
    const origRun = MockTmuxClass.prototype.run;
    MockTmuxClass.prototype.run = async function(subcommand: string, ...args: (string | number)[]) {
      runCalls.push({ subcommand, args });
      if (subcommand === "display-message" && args.includes("#{session_name}")) return "test-session";
      if (subcommand === "display-message" && args.includes("#{pane_current_path}")) return "/home/neo/repo";
      return "";
    };

    const windowWithQuote = "a'b";

    try {
      await cmdPr(windowWithQuote);
    } catch {
      // May throw on git/gh errors, that's OK — we just check the tmux calls
    } finally {
      MockTmuxClass.prototype.run = origRun;
    }

    // Find the call that uses the window-based target
    const targetCall = runCalls.find(c =>
      c.subcommand === "display-message" &&
      c.args.some(a => typeof a === "string" && a.includes("a'b")),
    );
    expect(targetCall).toBeDefined();
    // The window value must appear inside the target arg as a literal string
    const targetArg = targetCall!.args.find(a => typeof a === "string" && a.includes(windowWithQuote));
    expect(targetArg).toBeDefined();
    // The target arg must be the combined "session:window" value, NOT a shell-expanded string
    expect(String(targetArg)).toContain(windowWithQuote);
  });

  test("Case 3 — gh pr create uses Bun.spawn cwd option instead of cd in shell", async () => {
    runResponses.set("display-message", "/home/neo/repos/maw-js");

    try {
      await cmdPr();
    } catch { /* ignore errors — checking spawn calls */ }

    const ghCall = spawnCalls.find(c => c.cmd[0] === "gh");
    if (ghCall) {
      // cwd option must be set on the spawn call
      expect(ghCall.opts?.cwd).toBe("/home/neo/repos/maw-js");
      // gh cmd must NOT start with "cd " (no shell cd prepended)
      expect(ghCall.cmd[0]).toBe("gh");
      // gh cmd must NOT include any `cd '...'` pattern
      const hasShellCd = ghCall.cmd.some(a => typeof a === "string" && a.startsWith("cd "));
      expect(hasShellCd).toBe(false);
    }
  });

  test("Case 4 — outside tmux: throws immediately without calling Tmux.run", async () => {
    delete process.env.TMUX;
    await expect(cmdPr()).rejects.toThrow("not in a tmux session");
    expect(runCalls).toHaveLength(0);
  });

  test("Case 5 — branchToTitle handles issue branch correctly", async () => {
    runResponses.set("display-message", "/home/neo/repos/maw-js");
    // git returns an issue-prefixed branch
    spawnSpy.mockImplementation((cmd: any, opts?: any) => {
      spawnCalls.push({ cmd: Array.isArray(cmd) ? cmd : [cmd], opts });
      if (cmd[0] === "git") return makeMockProc("feat/issue-123-tmux-refactor\n") as any;
      if (cmd[0] === "gh") return makeMockProc("https://github.com/org/repo/pull/100\n") as any;
      return makeMockProc("") as any;
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await cmdPr();
    } finally {
      console.log = origLog;
    }

    // Should have logged issue link and PR success
    expect(logs.some(l => l.includes("#123"))).toBe(true);
    expect(logs.some(l => l.includes("✅"))).toBe(true);

    // gh command body should contain "Closes #123"
    const ghCall = spawnCalls.find(c => c.cmd[0] === "gh");
    expect(ghCall).toBeDefined();
    const bodyIdx = ghCall!.cmd.indexOf("--body");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(ghCall!.cmd[bodyIdx + 1]).toContain("Closes #123");
  });
});
