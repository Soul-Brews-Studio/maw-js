/**
 * demo plugin — unit tests
 *
 * Lives in test/isolated/ because the impl.ts uses hostExec from ssh.ts
 * which needs mock.module isolation to avoid global pollution.
 *
 * Strategy: inject fast=true + no-op sleep + captured exec to test the
 * narrative flow without real tmux or real sleeps.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mockSshModule } from "../helpers/mock-ssh";

// Mock ssh.ts before any import from the plugin tree
const execCalls: string[] = [];
const mockExec = async (cmd: string, _host?: string): Promise<string> => {
  execCalls.push(cmd);
  // Simulate pane listing returning some IDs so kill-pane gets a target
  if (cmd.includes("list-panes") && cmd.includes("-F #{pane_id}")) {
    return "%1\n%2\n%3\n";
  }
  return "";
};

mock.module("../../src/core/transport/ssh", () =>
  mockSshModule({ hostExec: mockExec }),
);

// Import after mocks are registered
const { cmdDemo } = await import("../../src/commands/plugins/demo/impl");

const noSleep = async (_ms: number) => {};

beforeEach(() => {
  execCalls.length = 0;
});

// ---------------------------------------------------------------------------
// No-tmux guard
// ---------------------------------------------------------------------------

describe("cmdDemo — no tmux guard", () => {
  test("prints friendly message and returns when $TMUX is not set", async () => {
    const savedTmux = process.env.TMUX;
    delete process.env.TMUX;
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { lines.push(s); return true; };
    try {
      await cmdDemo({ fast: true, sleep: noSleep, exec: mockExec });
    } finally {
      process.env.TMUX = savedTmux;
      (process.stdout as any).write = origWrite;
    }
    const output = lines.join("");
    expect(output).toContain("maw demo");
    expect(output).toContain("tmux");
    // Should NOT have spawned any panes
    const splitCalls = execCalls.filter((c) => c.includes("split-window"));
    expect(splitCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fast-mode end-to-end narrative
// ---------------------------------------------------------------------------

describe("cmdDemo — fast mode (inside tmux)", () => {
  test("runs full narrative and emits cost=$0 block", async () => {
    process.env.TMUX = "/tmp/tmux-test/default";
    process.env.TMUX_PANE = "%0";

    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => { lines.push(s); return true; };

    try {
      await cmdDemo({ fast: true, sleep: noSleep, exec: mockExec });
    } finally {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      (process.stdout as any).write = origWrite;
    }

    const output = lines.join("");

    // Narrator headers
    expect(output).toContain("maw demo");
    expect(output).toContain("agent-1");
    expect(output).toContain("agent-2");
    expect(output).toContain("broadcasting task");
    expect(output).toContain("cost data");

    // Cost table
    expect(output).toContain("$0.00");
    expect(output).toContain("demo mode");

    // Closing CTA
    expect(output).toContain("demo complete");
    expect(output).toContain("maw wake");
  });

  test("issues split-window calls when inside tmux", async () => {
    process.env.TMUX = "/tmp/tmux-test/default";
    process.env.TMUX_PANE = "%0";

    const captured: string[] = [];
    const captureExec = async (cmd: string): Promise<string> => {
      captured.push(cmd);
      if (cmd.includes("list-panes") && cmd.includes("-F #{pane_id}")) {
        return "%1\n%2\n%3\n";
      }
      return "";
    };

    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;

    try {
      await cmdDemo({ fast: true, sleep: noSleep, exec: captureExec });
    } finally {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      (process.stdout as any).write = origWrite;
    }

    const splitCalls = captured.filter((c) => c.includes("split-window"));
    expect(splitCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("cleans up panes in finally block", async () => {
    process.env.TMUX = "/tmp/tmux-test/default";
    process.env.TMUX_PANE = "%0";

    const captured: string[] = [];
    // Provide distinct before/after pane lists so cleanup targets are found
    let callCount = 0;
    const captureExec = async (cmd: string): Promise<string> => {
      captured.push(cmd);
      if (cmd.includes("list-panes") && cmd.includes("-F #{pane_id}")) {
        callCount++;
        // First call = before split1, return only %0
        // Second call = after split1, return %0 + %1 (new pane)
        // Third call = after split2, return %0 + %1 + %2 (another new pane)
        if (callCount === 1) return "%0\n";
        if (callCount === 2) return "%0\n%1\n";
        return "%0\n%1\n%2\n";
      }
      return "";
    };

    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;

    try {
      await cmdDemo({ fast: true, sleep: noSleep, exec: captureExec });
    } finally {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      (process.stdout as any).write = origWrite;
    }

    const killCalls = captured.filter((c) => c.includes("kill-pane"));
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// index.ts handler — CLI surface
// ---------------------------------------------------------------------------

describe("demo index handler — CLI", () => {
  test("--help returns ok:true with usage text", async () => {
    const { default: handler } = await import("../../src/commands/plugins/demo/index");
    const result = await handler({
      source: "cli",
      args: ["--help"],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw demo");
    expect(result.output).toContain("--fast");
    expect(result.output).toContain("tmux");
  });

  test("API source runs with fast=true and returns ok", async () => {
    process.env.TMUX = "/tmp/tmux-test/default";
    process.env.TMUX_PANE = "%0";
    const { default: handler } = await import("../../src/commands/plugins/demo/index");
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;
    let result;
    try {
      result = await handler({ source: "api", args: { fast: true } });
    } finally {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
      (process.stdout as any).write = origWrite;
    }
    expect(result.ok).toBe(true);
  });
});
