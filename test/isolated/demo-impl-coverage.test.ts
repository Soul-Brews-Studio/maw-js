import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { cmdDemo } = await import("../../src/vendor/mpr-plugins/demo/impl.ts?demo-impl-coverage");

const originalTmux = process.env.TMUX;
const originalTmuxPane = process.env.TMUX_PANE;
const originalWrite = process.stdout.write;

type ExecCall = { cmd: string };

let output = "";

function captureStdout(): void {
  output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
}

function restoreEnv(): void {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
}

beforeEach(() => {
  captureStdout();
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  restoreEnv();
});

describe("demo impl coverage", () => {
  test("cmdDemo prints tmux guidance and exits without side effects outside tmux", async () => {
    const calls: ExecCall[] = [];

    await cmdDemo({
      fast: true,
      sleep: async () => undefined,
      exec: async (cmd) => {
        calls.push({ cmd });
        throw new Error(`unexpected exec: ${cmd}`);
      },
    });

    expect(calls).toEqual([]);
    expect(output).toContain("maw demo");
    expect(output).toContain("This demo requires an active tmux session.");
    expect(output).toContain("tmux new-session -s demo");
  });

  test("cmdDemo orchestrates two tmux panes and cleans up temp scripts", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,100,0";
    process.env.TMUX_PANE = "%caller";

    const calls: ExecCall[] = [];
    const paneSnapshots = [
      "%caller",
      "%caller\n%agent1",
      "%caller\n%agent1",
      "%caller\n%agent1\n%agent2",
    ];

    await cmdDemo({
      fast: true,
      sleep: async () => undefined,
      exec: async (cmd) => {
        calls.push({ cmd });
        if (cmd === "tmux list-panes -a -F #{pane_id}") {
          return paneSnapshots.shift() ?? "%caller\n%agent1\n%agent2";
        }
        return "";
      },
    });

    const commands = calls.map((c) => c.cmd);
    expect(commands.filter((cmd) => cmd.startsWith("chmod +x '/tmp/maw-demo-")).length).toBe(2);
    expect(commands).toContain("tmux list-panes -a -F #{pane_id}");
    expect(commands.some((cmd) => cmd.includes("tmux split-window -t '%caller' -h -l 50%"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("bash /tmp/maw-demo-") && cmd.includes("[agent-1] session ended"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("tmux split-window -t '%agent1' -v -l 50%"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("bash /tmp/maw-demo-") && cmd.includes("[agent-2] session ended"))).toBe(true);
    expect(commands).toContain("tmux kill-pane -t '%agent2'");
    expect(commands).toContain("tmux kill-pane -t '%agent1'");
    expect(commands.filter((cmd) => cmd.startsWith("rm -f '/tmp/maw-demo-")).length).toBe(2);

    expect(output).toContain("🎬  maw demo — simulated multi-agent session");
    expect(output).toContain("agent-1 spawned (%agent1)");
    expect(output).toContain("agent-2 spawned (%agent2)");
    expect(output).toContain("COST REPORT — demo session");
    expect(output).toContain("✓ demo complete.");
  });

  test("cmdDemo still removes scripts when pane creation fails", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,100,0";
    process.env.TMUX_PANE = "%caller";

    const calls: ExecCall[] = [];

    await expect(cmdDemo({
      fast: true,
      sleep: async () => undefined,
      exec: async (cmd) => {
        calls.push({ cmd });
        if (cmd === "tmux list-panes -a -F #{pane_id}") return "%caller";
        if (cmd.includes("tmux split-window")) throw new Error("split failed");
        return "";
      },
    })).rejects.toThrow(/split failed/);

    const commands = calls.map((c) => c.cmd);
    expect(commands.filter((cmd) => cmd.startsWith("chmod +x '/tmp/maw-demo-")).length).toBe(2);
    expect(commands.filter((cmd) => cmd.startsWith("rm -f '/tmp/maw-demo-")).length).toBe(2);
    expect(commands.some((cmd) => cmd.startsWith("tmux kill-pane"))).toBe(false);
    expect(output).toContain("writing agent scripts");
    expect(output).toContain("spawning agent-1 in left pane");
  });

  test("cmdDemo falls back to caller pane when pane id discovery fails", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,100,0";
    process.env.TMUX_PANE = "%caller";

    const calls: ExecCall[] = [];

    await cmdDemo({
      fast: true,
      sleep: async () => undefined,
      exec: async (cmd) => {
        calls.push({ cmd });
        if (cmd === "tmux list-panes -a -F #{pane_id}") throw new Error("list panes unavailable");
        return "";
      },
    });

    const commands = calls.map((c) => c.cmd);
    expect(commands.filter((cmd) => cmd.startsWith("chmod +x '/tmp/maw-demo-")).length).toBe(2);
    expect(commands.some((cmd) => cmd.includes("tmux split-window -t '%caller' -h -l 50%"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("tmux split-window -t '%caller' -v -l 50%"))).toBe(true);
    expect(commands.some((cmd) => cmd.startsWith("tmux kill-pane"))).toBe(false);
    expect(commands.filter((cmd) => cmd.startsWith("rm -f '/tmp/maw-demo-")).length).toBe(2);
    expect(output).toContain("agent-1 spawned");
    expect(output).toContain("agent-2 spawned");
  });

  test("cmdDemo default sleep path remains usable in fast mode", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,100,0";
    process.env.TMUX_PANE = "%caller";

    const calls: ExecCall[] = [];
    const paneSnapshots = [
      "%caller",
      "%caller\n%agent1",
      "%caller\n%agent1",
      "%caller\n%agent1\n%agent2",
    ];

    await cmdDemo({
      fast: true,
      exec: async (cmd) => {
        calls.push({ cmd });
        if (cmd === "tmux list-panes -a -F #{pane_id}") {
          return paneSnapshots.shift() ?? "%caller\n%agent1\n%agent2";
        }
        return "";
      },
    });

    expect(calls.map((c) => c.cmd)).toContain("tmux kill-pane -t '%agent2'");
    expect(output).toContain("✓ demo complete.");
  });
});
