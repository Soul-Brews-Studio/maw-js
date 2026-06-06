/**
 * Engine-aware retrospective selection for done-autosave's autoSave (#2099 follow-up).
 *
 * Verifies inferRetrospectiveCommand's three outcomes, observed through autoSave:
 *   - claude (default)      -> sends "/rrr"
 *   - omx / oh-my-codex     -> sends "$rrr"
 *   - codex / aider / opencode -> skips the retro entirely (no tmux send, no 10s wait)
 *
 * Mocks are registered before importing the target module (it captures SDK,
 * reunion, and soul-sync imports at load time).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-done-engine-retro-"));

let hostExecHandler: (command: string) => string | Promise<string> = () => "";
let sentTexts: Array<{ target: string; text: string }> = [];

mock.module("os", () => ({ homedir: () => join(SANDBOX, "home") }));

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => await hostExecHandler(command),
  tmux: {
    sendText: async (target: string, text: string) => {
      sentTexts.push({ target, text });
    },
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/internal/reunion-impl"), () => ({
  cmdReunion: async () => {},
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/done/internal/soul-sync-impl"), () => ({
  cmdSoulSync: async () => [],
}));

const { autoSave } = await import("../../src/vendor/mpr-plugins/done/done-autosave.ts?engine-retro");

beforeEach(() => {
  sentTexts = [];
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function paneRunning(engine: string): void {
  hostExecHandler = (command) =>
    command.includes("pane_current_path") ? `${engine}\t/repo/worktree\n` : "";
}

async function captureConsole(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

async function withImmediateTimers(fn: () => Promise<void>): Promise<number[]> {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    delays.push(timeout ?? 0);
    if (typeof handler === "function") handler(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await fn();
    return delays;
  } finally {
    globalThis.setTimeout = original;
  }
}

describe("done autosave engine-aware retro", () => {
  for (const engine of ["claude", "node"]) {
    test(`${engine} pane sends /rrr`, async () => {
      paneRunning(engine);
      let delays: number[] = [];
      const output = await captureConsole(async () => {
        delays = await withImmediateTimers(() => autoSave("tile-1", "work", {}));
      });
      expect(sentTexts).toEqual([{ target: "work:tile-1", text: "/rrr" }]);
      expect(delays).toEqual([10_000]);
      expect(output).toContain("/rrr sent (waited 10s)");
    });
  }

  for (const engine of ["omx", "oh-my-codex"]) {
    test(`${engine} pane sends $rrr`, async () => {
      paneRunning(engine);
      let delays: number[] = [];
      const output = await captureConsole(async () => {
        delays = await withImmediateTimers(() => autoSave("tile-1", "work", {}));
      });
      expect(sentTexts).toEqual([{ target: "work:tile-1", text: "$rrr" }]);
      expect(delays).toEqual([10_000]);
      expect(output).toContain("$rrr sent (waited 10s)");
    });
  }

  for (const engine of ["codex", "aider", "opencode"]) {
    test(`${engine} pane skips the retro entirely`, async () => {
      paneRunning(engine);
      let delays: number[] = [];
      const output = await captureConsole(async () => {
        delays = await withImmediateTimers(() => autoSave("tile-1", "work", {}));
      });
      // No retro command sent and no 10s wait incurred.
      expect(sentTexts).toEqual([]);
      expect(delays).toEqual([]);
      expect(output).toContain("no retrospective command for this engine");
      // Git auto-save still runs for skipped engines.
      expect(output).toContain("committed changes");
    });

    test(`${engine} dry-run announces the skip without sending`, async () => {
      paneRunning(engine);
      const output = await captureConsole(() => autoSave("tile-1", "work", { dryRun: true }));
      expect(sentTexts).toEqual([]);
      expect(output).toContain("would skip retro");
      expect(output).not.toContain("would send");
    });
  }
});
