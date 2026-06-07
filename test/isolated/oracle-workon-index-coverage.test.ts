/**
 * Targeted isolated coverage for src/vendor/mpr-plugins/oracle-workon/index.ts.
 *
 * The command mostly parses CLI args, shapes console output, and shells out to
 * maw/tmux. child_process is mocked so these tests exercise index-level routing
 * without creating worktrees, panes, or swarm sessions.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalCwd = process.cwd();
const originalTmux = process.env.TMUX;
const originalSetTimeout = globalThis.setTimeout;
const tempDirs: string[] = [];

type ExecOptions = Record<string, unknown> | undefined;

let execCalls: Array<{ cmd: string; options: ExecOptions }> = [];
let paneListOutput = "";
let execSyncImpl: (cmd: string, options: ExecOptions) => string = (cmd) => {
  if (cmd.startsWith("tmux list-panes")) return paneListOutput;
  return "";
};

mock.module("child_process", () => ({
  execSync: (cmd: string, options?: ExecOptions) => {
    execCalls.push({ cmd, options });
    return execSyncImpl(cmd, options);
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/oracle-workon/index.ts?oracle-workon-index-coverage");

function resetEnv() {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
}

function chdirTemp(name: string) {
  const dir = mkdtempSync(join(tmpdir(), name));
  tempDirs.push(dir);
  process.chdir(dir);
  return dir;
}

function chdirTempChild(parentPrefix: string, childBasename: string) {
  const parent = mkdtempSync(join(tmpdir(), parentPrefix));
  tempDirs.push(parent);
  const dir = join(parent, childBasename);
  mkdirSync(dir);
  process.chdir(dir);
  return dir;
}

function fastTimers() {
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
    fn(...args);
    return 0 as any;
  }) as typeof setTimeout;
}

beforeEach(() => {
  execCalls = [];
  paneListOutput = "";
  execSyncImpl = (cmd) => {
    if (cmd.startsWith("tmux list-panes")) return paneListOutput;
    return "";
  };
  process.chdir(originalCwd);
  resetEnv();
  globalThis.setTimeout = originalSetTimeout;
});

afterEach(() => {
  process.chdir(originalCwd);
  resetEnv();
  globalThis.setTimeout = originalSetTimeout;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("oracle-workon plugin index", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "oracle-workon",
      description: "Spawn a worktree team for oracle work — composes maw wake --task --split + maw swarm.",
    });
  });

  test("prints help through ctx.writer when invocation is not cli", async () => {
    const written: string[] = [];

    const result = await handler({
      source: "api",
      args: ["ignored"],
      writer: (...args: unknown[]) => written.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("maw oracle-workon");
    expect(written[0]).toContain("--task <slug>");
    expect(execCalls).toEqual([]);
  });

  test("rejects execution outside tmux before parsing task details", async () => {
    delete process.env.TMUX;

    const result = await handler({ source: "cli", args: ["--task", "ship-fix"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not in tmux");
    expect(result.output).toContain("requires tmux");
    expect(result.output).toContain("tmux attach");
    expect(execCalls).toEqual([]);
  });

  test("requires --task once tmux is available", async () => {
    process.env.TMUX = "%0";

    const result = await handler({ source: "cli", args: ["arra"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing --task");
    expect(result.output).toContain("--task <slug> is required");
    expect(execCalls).toEqual([]);
  });

  test("returns oracle detection guidance when cwd is not an oracle repo", async () => {
    process.env.TMUX = "%0";
    chdirTemp("plain-workspace-");

    const result = await handler({ source: "cli", args: ["--task", "ship-fix"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("oracle not detected");
    expect(result.output).toContain("is not an oracle repo");
    expect(result.output).toContain("Pass <oracle> as positional");
    expect(execCalls).toEqual([]);
  });

  test("builds escaped dry-run wake and tiled swarm commands for explicit oracle", async () => {
    process.env.TMUX = "%0";

    const result = await handler({
      source: "cli",
      args: [
        "arra",
        "--task",
        "ship-fix",
        "--with",
        "codex, thclaws,,",
        "--engine",
        "claude46",
        "--prompt",
        "ship Bob's fix",
        "--tiled",
        "--dry-run",
      ],
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("oracle:  arra");
    expect(result.output).toContain("slug:    ship-fix");
    expect(result.output).toContain("engine:  claude46");
    expect(result.output).toContain("agents:  codex thclaws");
    expect(result.output).toContain("▶ maw wake arra --task ship-fix --split --no-attach --engine claude46 --prompt 'ship Bob'\\''s fix'");
    expect(result.output).toContain("▶ (in new pane) maw swarm codex thclaws --tiled");
    expect(result.output).toContain("[dry-run] no changes made.");
    expect(execCalls).toEqual([]);
  });

  test("auto-detects oracle from cwd and runs leader without swarm agents", async () => {
    process.env.TMUX = "%0";
    fastTimers();
    chdirTempChild("oracle-workon-", "pulse-oracle");

    const result = await handler({ source: "cli", args: ["--task", "ship-fix"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("auto-detected oracle: pulse (from cwd: pulse-oracle");
    expect(result.output).toContain("agents:  none");
    expect(result.output).toContain("leader:    (check: maw panes)");
    expect(result.output).toContain("cleanup:   maw done pulse-ship-fix");
    expect(execCalls).toEqual([
      {
        cmd: "maw wake pulse --task ship-fix --split --no-attach --engine claude47",
        options: { stdio: "inherit" },
      },
    ]);
  });

  test("finds the new leader pane and launches swarm agents in that pane", async () => {
    process.env.TMUX = "%0";
    fastTimers();
    paneListOutput = "%1 shell\n%9 codex-long-investigation-pane\n";

    const result = await handler({
      source: "cli",
      args: ["arra", "--task", "long-investigation", "--with", "codex,thclaws"],
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("▶ maw wake arra --task long-investigation --split --no-attach --engine claude47");
    expect(result.output).toContain("▶ (in %9) maw swarm codex thclaws");
    expect(result.output).toContain("leader:    %9");
    expect(result.output).toContain("agents:    codex thclaws");
    expect(execCalls).toEqual([
      {
        cmd: "maw wake arra --task long-investigation --split --no-attach --engine claude47",
        options: { stdio: "inherit" },
      },
      {
        cmd: "tmux list-panes -a -F '#{pane_id} #{pane_title}'",
        options: { encoding: "utf8" },
      },
      {
        cmd: "maw run %9 'maw swarm codex thclaws'",
        options: { stdio: "inherit" },
      },
    ]);
  });

  test("keeps successful leader result but skips swarm when the new pane cannot be found", async () => {
    process.env.TMUX = "%0";
    fastTimers();
    paneListOutput = "%1 unrelated\n%2 also-unrelated\n";

    const result = await handler({ source: "cli", args: ["arra", "--task", "ship-cache", "--with", "codex"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Could not find new pane via title");
    expect(result.output).toContain("leader is up; swarm skipped");
    expect(execCalls).toEqual([
      {
        cmd: "maw wake arra --task ship-cache --split --no-attach --engine claude47",
        options: { stdio: "inherit" },
      },
      {
        cmd: "tmux list-panes -a -F '#{pane_id} #{pane_title}'",
        options: { encoding: "utf8" },
      },
    ]);
  });

  test("surfaces shell failures with buffered context", async () => {
    process.env.TMUX = "%0";
    fastTimers();
    execSyncImpl = (cmd) => {
      if (cmd.startsWith("maw wake")) throw new Error("wake exploded");
      return "";
    };

    const result = await handler({ source: "cli", args: ["arra", "--task", "ship-fix"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("oracle:  arra");
    expect(result.error).toContain("▶ maw wake arra --task ship-fix --split --no-attach --engine claude47");
    expect(result.output).toBe(result.error);
  });
});
