/**
 * Tests for `maw pane` plugin (#1269).
 *
 * Strategy: thin facade — we test that
 *   1. The handler routes subcommands correctly (split/kill/peek/list).
 *   2. Each subcommand wrapper validates inputs before delegating.
 *   3. Delegation reaches the underlying tmux helpers with the right args.
 *
 * For (3) we mock ssh.ts via the canonical helper so `hostExec` captures
 * the exact tmux command string — same approach as `tmux.test.ts`.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mockSshModule } from "../helpers/mock-ssh";
import { mockConfigModule } from "../helpers/mock-config";

// Capture all tmux commands shelled out
let commands: string[] = [];
let nextResult = "";

mock.module("../../src/config", () => mockConfigModule(() => ({ host: "white.local" })));

function installSshMock() {
  mock.module("../../src/core/transport/ssh", () => mockSshModule({
    hostExec: async (cmd: string) => {
      commands.push(cmd);
      return nextResult;
    },
    ssh: async (cmd: string) => {
      commands.push(cmd);
      return nextResult;
    },
  }));
}
installSshMock();

beforeEach(() => {
  commands = [];
  nextResult = "";
  installSshMock();
});

// ── Handler dispatch ────────────────────────────────────────────────────────

describe("pane handler — dispatch", () => {
  test("no args → prints usage, returns ok", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: [] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("usage: maw pane");
    expect(res.output).toContain("split");
    expect(res.output).toContain("kill");
    expect(res.output).toContain("peek");
    expect(res.output).toContain("list");
  });

  test("--help → prints usage, returns ok", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("usage: maw pane");
  });

  test("unknown subcommand → returns ok:false with error", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["bogus"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown subcommand");
    expect(res.error).toContain("bogus");
  });

  test("split --help → prints split usage", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["split", "--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("maw pane split");
    expect(res.output).toContain("-h, --horizontal");
    expect(res.output).toContain("-v, --vertical");
  });

  test("kill --help → prints kill usage", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["kill", "--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("maw pane kill");
    expect(res.output).toContain("--force");
  });

  test("peek --help → prints peek usage with --lines and --history", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["peek", "--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("maw pane peek");
    expect(res.output).toContain("--lines");
    expect(res.output).toContain("--history");
  });

  test("list --help → prints list usage", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["list", "--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("maw pane list");
    expect(res.output).toContain("--all");
  });

  test("ls is an alias for list", async () => {
    // ls without args should not error on dispatch — it should hit the list handler.
    // We don't care about output content here, just that it routes (no "unknown").
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["ls", "--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("maw pane list");
  });
});

// ── pane split — validation ─────────────────────────────────────────────────

describe("cmdPaneSplit — validation", () => {
  test("-h and -v together → throws", async () => {
    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    await expect(cmdPaneSplit("echo hi", { horizontal: true, vertical: true }))
      .rejects.toThrow(/mutually exclusive/);
  });

  test("no $TMUX and no target → throws", async () => {
    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    const orig = process.env.TMUX;
    delete process.env.TMUX;
    const origPane = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    try {
      await expect(cmdPaneSplit("echo hi", {}))
        .rejects.toThrow(/active tmux|explicit -t target/);
    } finally {
      if (orig !== undefined) process.env.TMUX = orig;
      if (origPane !== undefined) process.env.TMUX_PANE = origPane;
    }
  });

  test("invalid pct propagates from cmdTmuxSplit", async () => {
    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    await expect(cmdPaneSplit("", { target: "%999", pct: 0 }))
      .rejects.toThrow(/pct must be 1-99/);
    await expect(cmdPaneSplit("", { target: "%999", pct: 150 }))
      .rejects.toThrow(/pct must be 1-99/);
  });
});

// ── pane split — delegation ─────────────────────────────────────────────────

describe("cmdPaneSplit — delegation to tmux split-window", () => {
  test("explicit target + horizontal default → tmux split-window -h -l 50%", async () => {
    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    await cmdPaneSplit("echo hello", { target: "%999" });
    expect(commands.length).toBeGreaterThan(0);
    const splitCmd = commands.find(c => c.startsWith("tmux split-window"));
    expect(splitCmd).toBeDefined();
    expect(splitCmd).toContain("-h");
    expect(splitCmd).toContain("-l 50%");
    expect(splitCmd).toContain("-t '%999'");
    expect(splitCmd).toContain("'echo hello'");
  });

  test("vertical + custom pct + custom command", async () => {
    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    await cmdPaneSplit("tail -f log.txt", { target: "mawjs-view", vertical: true, pct: 30 });
    const splitCmd = commands.find(c => c.startsWith("tmux split-window"));
    expect(splitCmd).toBeDefined();
    expect(splitCmd).toContain("-v");
    expect(splitCmd).toContain("-l 30%");
    expect(splitCmd).toContain("'tail -f log.txt'");
  });

  test("no command → tmux split-window without trailing cmd arg", async () => {
    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    await cmdPaneSplit("", { target: "%999" });
    const splitCmd = commands.find(c => c.startsWith("tmux split-window"));
    expect(splitCmd).toBeDefined();
    // Without a command, cmdTmuxSplit's cmdSuffix is empty — the command string
    // ends right after the target flag (no trailing single-quoted arg).
    expect(splitCmd!.trim()).toMatch(/-t '%999'\s*$/);
  });
});

// ── pane kill — validation + delegation ─────────────────────────────────────

describe("cmdPaneKill", () => {
  test("missing ref → throws", async () => {
    const { cmdPaneKill } = await import("../../src/commands/plugins/pane/kill");
    await expect(cmdPaneKill("")).rejects.toThrow(/pane-ref required/);
  });

  test("kill %999 → tmux kill-pane (not kill-session)", async () => {
    const { cmdPaneKill } = await import("../../src/commands/plugins/pane/kill");
    await cmdPaneKill("%999");
    const killCmd = commands.find(c => c.includes("kill-pane") || c.includes("kill-session"));
    expect(killCmd).toBeDefined();
    expect(killCmd).toContain("kill-pane");
    expect(killCmd).not.toContain("kill-session");
    expect(killCmd).toContain("%999");
  });

  test("handler routes 'kill' to cmdPaneKill", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["kill"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pane-ref required");
  });
});

// ── pane peek — validation + delegation ─────────────────────────────────────

describe("cmdPanePeek", () => {
  test("missing ref → throws", async () => {
    const { cmdPanePeek } = await import("../../src/commands/plugins/pane/peek");
    await expect(cmdPanePeek("")).rejects.toThrow(/pane-ref required/);
  });

  test("peek %999 → tmux capture-pane", async () => {
    const { cmdPanePeek } = await import("../../src/commands/plugins/pane/peek");
    nextResult = "fake pane content";
    await cmdPanePeek("%999");
    const captureCmd = commands.find(c => c.startsWith("tmux capture-pane"));
    expect(captureCmd).toBeDefined();
    expect(captureCmd).toContain("%999");
  });

  test("--lines flag forwards to capture-pane scroll range", async () => {
    const { cmdPanePeek } = await import("../../src/commands/plugins/pane/peek");
    nextResult = "x";
    await cmdPanePeek("%999", { lines: 100 });
    const captureCmd = commands.find(c => c.startsWith("tmux capture-pane"));
    expect(captureCmd).toContain("-S -100");
  });

  test("--history flag forwards to full scrollback", async () => {
    const { cmdPanePeek } = await import("../../src/commands/plugins/pane/peek");
    nextResult = "x";
    await cmdPanePeek("%999", { history: true });
    const captureCmd = commands.find(c => c.startsWith("tmux capture-pane"));
    expect(captureCmd).toContain("-S -");
    expect(captureCmd).not.toContain("-S -30");
  });

  test("handler routes 'peek' to cmdPanePeek", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    const res = await handler({ source: "cli", args: ["peek"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pane-ref required");
  });
});

// ── pane list — delegation ──────────────────────────────────────────────────

describe("cmdPaneList", () => {
  test("calls tmux list-panes (via cmdTmuxLs)", async () => {
    const { cmdPaneList } = await import("../../src/commands/plugins/pane/list");
    nextResult = "";
    await cmdPaneList({ all: true });
    const listCmd = commands.find(c => c.includes("list-panes"));
    expect(listCmd).toBeDefined();
  });

  test("handler 'list' routes through and produces output", async () => {
    const handler = (await import("../../src/commands/plugins/pane/index")).default;
    nextResult = "";
    const res = await handler({ source: "cli", args: ["list", "--all"] });
    expect(res.ok).toBe(true);
    // No panes returned → "No panes found" message hits the captured output.
    expect(res.output).toBeDefined();
  });
});
