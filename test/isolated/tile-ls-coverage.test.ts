/**
 * Focused index-level coverage for the tile and ls plugins.
 *
 * Isolated because these entrypoints mock dynamically imported command
 * implementations and globally capture console output while handlers run.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const tileImplPath = import.meta.resolve("../../src/commands/plugins/tile/impl");
const lsPeerCallPath = import.meta.resolve("../../src/vendor/mpr-plugins/ls/internal/peer-call");

let tileCalls: Array<{ count: number; opts: Record<string, unknown> }> = [];
let tileCleanCalls = 0;
let tileSwapCalls: Array<{ a: string; b: string }> = [];
let tileThrow: string | null = null;

mock.module(tileImplPath, () => ({
  cmdTile: async (count: number, opts: Record<string, unknown>) => {
    tileCalls.push({ count, opts });
    if (tileThrow === "tile") throw new Error("tile exploded");
    console.log(`tile ${count}`);
  },
  cmdTileClean: async () => {
    tileCleanCalls += 1;
    if (tileThrow === "clean") throw new Error("clean exploded");
    console.log("tile clean");
  },
  cmdTileSwap: async (a: string, b: string) => {
    tileSwapCalls.push({ a, b });
    if (tileThrow === "swap") throw new Error("swap exploded");
    console.log(`tile swap ${a} ${b}`);
  },
}));

let cmdListCalls: Array<Record<string, unknown> | undefined> = [];
let cmdListBehavior: "ok" | "log-then-throw" | "throw" = "ok";
let tmuxLsCalls: Array<Record<string, unknown>> = [];

mock.module("maw-js/commands/plugins/tmux/impl", () => {
  const parseActiveDurationSeconds = (raw?: string): number | undefined => {
    if (!raw) return undefined;
    const match = /^(\d+)([smhd])?$/.exec(raw.trim().toLowerCase());
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    const unit = match[2] ?? "m";
    return value * (unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400);
  };
  return {
    activeDurationArg: (argv: string[]) => {
      const index = argv.indexOf("--active");
      const next = index >= 0 ? argv[index + 1] : undefined;
      return next && !next.startsWith("-") && parseActiveDurationSeconds(next) ? next : undefined;
    },
    cmdTmuxLs: async (opts: Record<string, unknown>) => {
      tmuxLsCalls.push(opts);
      console.log(`tmux ls ${opts.activeThresholdSec ?? "default"}`);
    },
    parseActiveDurationSeconds,
  };
});

mock.module("maw-js/commands/shared/comm", () => ({
  cmdList: async (opts?: Record<string, unknown>) => {
    cmdListCalls.push(opts);
    if (cmdListBehavior === "log-then-throw") {
      console.error("local list warning");
      throw new Error("local list exploded");
    }
    if (cmdListBehavior === "throw") throw new Error("local list exploded");
    console.log(`local list ${opts?.fix ? "fix" : "plain"}`);
    console.error("local err stream");
  },
}));

let lsPeerCalls: Array<{ peer: string; opts: Record<string, unknown> }> = [];
let lsAllPeersCalls: Array<Record<string, unknown>> = [];
let peerThrow: string | null = null;

mock.module(lsPeerCallPath, () => ({
  lsPeer: async (peer: string, opts: Record<string, unknown>) => {
    lsPeerCalls.push({ peer, opts });
    if (peerThrow === "peer") throw new Error("peer exploded");
    return { ok: true, output: `peer ${peer} ${opts.json ? "json" : "text"}` };
  },
  lsAllPeers: async (opts: Record<string, unknown>) => {
    lsAllPeersCalls.push(opts);
    if (peerThrow === "all") throw new Error("all exploded");
    return { ok: true, output: `all ${opts.json ? "json" : "text"}` };
  },
}));

const { command: tileCommand, default: tileHandler } = await import("../../src/commands/plugins/tile/index.ts?tile-ls-coverage");
const { command: lsCommand, default: lsHandler } = await import("../../src/vendor/mpr-plugins/ls/index.ts?tile-ls-coverage");

const originalTmux = process.env.TMUX;

beforeEach(() => {
  tileCalls = [];
  tileCleanCalls = 0;
  tileSwapCalls = [];
  tileThrow = null;
  process.env.TMUX = "/tmp/tmux-1000/default,1,0";

  cmdListCalls = [];
  cmdListBehavior = "ok";
  tmuxLsCalls = [];
  lsPeerCalls = [];
  lsAllPeersCalls = [];
  peerThrow = null;
});

afterAll(() => {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

describe("tile plugin index coverage", () => {
  test("exports metadata and rejects use outside tmux before parsing or importing command implementations", async () => {
    delete process.env.TMUX;

    const result = await tileHandler({ source: "cli", args: ["3", "--wt"] } as any);

    expect(tileCommand).toEqual({
      name: "tile",
      description: "Arrange the current window into a grid or spawn tile panes; use panes to inspect and pane swap to move panes.",
    });
    expect(result).toEqual({ ok: false, error: "not in tmux" });
    expect(tileCalls).toEqual([]);
  });

  test("renders help text and captures it in output when no writer is supplied", async () => {
    const result = await tileHandler({ source: "cli", args: ["--help"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw tile [N] [--wt <name>] [--path <dir>] [--cmd <cmd>]");
    expect(result.output).toContain("maw tile 3 -p /repo -c \"bun test\"");
    expect(result.output).toContain("maw tile 3 --wt feat");
    expect(result.output).toContain("maw tile clean");
    expect(result.output).toContain("maw tile swap top bottom");
    expect(tileCalls).toEqual([]);
  });

  test("routes API/default, numeric spawn, --wt/--engine, clean, and swap branches", async () => {
    let result = await tileHandler({ source: "api", args: ["ignored"] } as any);
    expect(result).toEqual({ ok: true, output: "tile 0" });

    result = await tileHandler({ source: "cli", args: ["3", "--wt", "explore", "-p", "src", "-c", "bun test", "--shell", "-e", "claude"] } as any);
    expect(result).toEqual({ ok: true, output: "tile 3" });

    result = await tileHandler({ source: "cli", args: ["2", "--wt"] } as any);
    expect(result).toEqual({ ok: true, output: "tile 2" });

    result = await tileHandler({ source: "cli", args: ["clean"] } as any);
    expect(result).toEqual({ ok: true, output: "tile clean" });

    result = await tileHandler({ source: "cli", args: ["swap", "%1", "tile-2"] } as any);
    expect(result).toEqual({ ok: true, output: "tile swap %1 tile-2" });

    expect(tileCalls).toEqual([
      { count: 0, opts: { wt: false, path: undefined, cmd: undefined, shell: false, engine: undefined } },
      { count: 3, opts: { wt: "explore", path: "src", cmd: "bun test", shell: true, engine: "claude" } },
      { count: 2, opts: { wt: true, path: undefined, cmd: undefined, shell: false, engine: undefined } },
    ]);
    expect(tileCleanCalls).toBe(1);
    expect(tileSwapCalls).toEqual([{ a: "%1", b: "tile-2" }]);
  });

  test("reports missing swap operands, invalid counts, and implementation exceptions", async () => {
    let result = await tileHandler({ source: "cli", args: ["swap", "only-one"] } as any);
    expect(result).toEqual({
      ok: false,
      error: "two pane targets required",
      output: "usage: maw tile swap <pane-a> <pane-b>",
    });

    result = await tileHandler({ source: "cli", args: ["three"] } as any);
    expect(result).toEqual({ ok: false, error: "invalid count" });

    tileThrow = "tile";
    result = await tileHandler({ source: "cli", args: ["2"] } as any);
    expect(result).toEqual({ ok: false, error: "tile exploded", output: undefined });
  });

  test("streams tile output through ctx.writer without duplicating captured output", async () => {
    const writes: string[] = [];

    const result = await tileHandler({
      source: "cli",
      args: ["1"],
      writer: (...parts: unknown[]) => writes.push(parts.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(writes).toEqual(["tile 1"]);
  });
});

describe("ls plugin index coverage", () => {
  test("exports metadata and routes non-CLI calls to local cmdList with writer-backed log/error streaming", async () => {
    const writes: string[] = [];

    const result = await lsHandler({
      source: "api",
      args: { ignored: true },
      writer: (...parts: unknown[]) => writes.push(parts.map(String).join(" ")),
    } as any);

    expect(lsCommand).toEqual({
      name: "ls",
      description: "List live sessions and agents; use maw fleet ls for registered fleet config.",
    });
    expect(result).toEqual({ ok: true, output: undefined });
    expect(cmdListCalls).toEqual([undefined]);
    expect(writes).toEqual(["local list plain", "local err stream"]);
  });

  test("renders help without calling local or peer listing implementations", async () => {
    const result = await lsHandler({ source: "cli", args: ["-h"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw ls --all");
    expect(result.output).toContain("maw fleet ls");
    expect(cmdListCalls).toEqual([]);
    expect(lsPeerCalls).toEqual([]);
    expect(lsAllPeersCalls).toEqual([]);
  });

  test("routes peer positional before --all, all-peers, and default local --fix branches", async () => {
    let result = await lsHandler({ source: "cli", args: ["clinic", "--all", "--json"] } as any);
    expect(result).toEqual({ ok: true, output: "peer clinic json" });

    result = await lsHandler({ source: "cli", args: ["--all"] } as any);
    expect(result).toEqual({ ok: true, output: "all text" });

    result = await lsHandler({ source: "cli", args: ["--fix"] } as any);
    expect(result).toEqual({ ok: true, output: "local list fix\nlocal err stream" });

    expect(lsPeerCalls).toEqual([{ peer: "clinic", opts: { json: true } }]);
    expect(lsAllPeersCalls).toEqual([{ json: false }]);
    expect(cmdListCalls).toEqual([{ fix: true, verify: false }]);
  });

  test("routes --active to local tmux activity filtering before peer positional handling", async () => {
    const result = await lsHandler({ source: "cli", args: ["--active", "1h", "mawjs", "--json"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("tmux ls 3600");
    expect(tmuxLsCalls).toEqual([{
      all: true,
      compact: true,
      json: true,
      active: true,
      activeThresholdSec: 3600,
      filter: "mawjs",
      oracleOnly: true,
    }]);
    expect(lsPeerCalls).toEqual([]);
    expect(cmdListCalls).toEqual([]);
  });

  test("returns captured stderr as catch error/output when local listing logs before throwing", async () => {
    cmdListBehavior = "log-then-throw";

    const result = await lsHandler({ source: "cli", args: [] } as any);

    expect(result).toEqual({ ok: false, error: "local list warning", output: "local list warning" });
  });

  test("falls back to thrown error messages when no logs were captured", async () => {
    cmdListBehavior = "throw";

    let result = await lsHandler({ source: "cli", args: [] } as any);
    expect(result).toEqual({ ok: false, error: "local list exploded", output: undefined });

    peerThrow = "all";
    result = await lsHandler({ source: "cli", args: ["--all", "--json"] } as any);
    expect(result).toEqual({ ok: false, error: "all exploded", output: undefined });
  });
});
