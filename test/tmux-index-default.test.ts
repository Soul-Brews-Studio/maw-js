import { afterEach, describe, expect, test } from "bun:test";
import { createTmuxHandler } from "../src/commands/plugins/tmux/index";
import type { InvokeContext } from "../src/plugin/types";

type Call = [string, ...unknown[]];

const OLD_TMUX = process.env.TMUX;
const OLD_TMUX_PANE = process.env.TMUX_PANE;

afterEach(() => {
  if (OLD_TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = OLD_TMUX;
  if (OLD_TMUX_PANE === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = OLD_TMUX_PANE;
});

function makeHarness(overrides: Record<string, any> = {}) {
  const calls: Call[] = [];
  const deps = {
    cmdTmuxPeek: async (target: string, opts: unknown) => { calls.push(["peek", target, opts]); },
    cmdTmuxLs: async (opts: unknown) => { calls.push(["ls", opts]); },
    cmdTmuxSend: async (target: string, command: string, opts: unknown) => { calls.push(["send", target, command, opts]); },
    cmdTmuxSplit: async (target: string, opts: unknown) => { calls.push(["split", target, opts]); },
    cmdTmuxKill: async (target: string, opts: unknown) => { calls.push(["kill", target, opts]); },
    cmdTmuxLayout: async (target: string, preset: string) => { calls.push(["layout", target, preset]); },
    cmdTmuxPipePane: async (target: string, command: string | undefined, opts: unknown) => { calls.push(["pipe", target, command, opts]); },
    cmdTmuxSynchronizePanes: async (target: string, on: boolean) => { calls.push(["sync", target, on]); },
    cmdTmuxAttach: (target: string, opts: unknown) => { calls.push(["attach", target, opts]); },
    resolveTmuxTarget: (target: string) => ({ resolved: `resolved-${target}`, source: "test" }),
    hostExec: async (cmd: string) => { calls.push(["hostExec", cmd]); return ""; },
    cmdSplit: async (target: string, opts: unknown) => { calls.push(["cmdSplit", target, opts]); },
    ...overrides,
  };
  return { calls, handler: createTmuxHandler(deps as any) };
}

function cli(args: string[], writer?: (...a: any[]) => void): InvokeContext {
  return { source: "cli", args, writer } as any;
}

describe("tmux plugin command handler", () => {
  test("prints top-level help for no subcommand and non-cli invocations", async () => {
    const h = makeHarness();
    const noSub = await h.handler(cli([]));
    expect(noSub).toMatchObject({ ok: true });
    expect(noSub.output).toContain("usage: maw tmux");

    const nonCli = await h.handler({ source: "api", args: ["send", "pane", "cmd"] } as any);
    expect(nonCli).toMatchObject({ ok: true });
    expect(nonCli.output).toContain("usage: maw tmux");
  });

  test("routes send help, validation, and flags", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["send", "--help"]))).output).toContain("--allow-destructive");
    expect(await h.handler(cli(["send", "pane"]))).toMatchObject({ ok: false, error: "target and command required" });

    expect(await h.handler(cli(["send", "pane", "echo", "hi", "--literal", "--allow-destructive", "--force"]))).toMatchObject({ ok: true });
    expect(h.calls).toContainEqual(["send", "pane", "echo hi", { literal: true, allowDestructive: true, force: true }]);
  });

  test("routes ls/list help and recent compact options", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["ls", "--help"]))).output).toContain("--recent");
    expect((await h.handler(cli(["ls", "--help"]))).output).toContain("--active");

    await h.handler(cli(["list", "--recent", "2", "--active", "1h", "--json", "--verbose", "--roster"]));
    expect(h.calls).toContainEqual(["ls", {
      all: true,
      json: true,
      compact: true,
      verbose: true,
      roster: true,
      recent: true,
      recentLimit: 2,
      active: true,
      activeThresholdSec: 3600,
    }]);

    await h.handler(cli(["ls", "--compact", "0"]));
    expect(h.calls).toContainEqual(["ls", {
      all: false,
      json: false,
      compact: true,
      verbose: false,
      roster: false,
      recent: false,
      recentLimit: undefined,
    }]);
  });

  test("routes peek help, validation, and options", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["peek", "--help"]))).output).toContain("maw tmux peek");
    expect(await h.handler(cli(["peek"]))).toMatchObject({ ok: false, error: "target required" });

    await h.handler(cli(["peek", "pane", "--lines", "12", "--history"]));
    expect(h.calls).toContainEqual(["peek", "pane", { lines: 12, history: true }]);
  });

  test("routes split help, validation, and options", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["split", "--help"]))).output).toContain("maw tmux split");
    expect(await h.handler(cli(["split"]))).toMatchObject({ ok: false, error: "target required" });

    await h.handler(cli(["split", "pane", "-v", "--pct", "40", "--cmd", "bash"]));
    expect(h.calls).toContainEqual(["split", "pane", { vertical: true, pct: 40, cmd: "bash" }]);
  });

  test("routes kill help, validation, and options", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["kill", "--help"]))).output).toContain("kill the whole session");
    expect(await h.handler(cli(["kill"]))).toMatchObject({ ok: false, error: "target required" });

    await h.handler(cli(["kill", "pane", "--force", "--session"]));
    expect(h.calls).toContainEqual(["kill", "pane", { force: true, session: true }]);
  });

  test("routes layout help, validation, success, and command errors", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["layout", "--help"]))).output).toContain("presets:");
    expect(await h.handler(cli(["layout", "pane"]))).toMatchObject({ ok: false, error: "target and preset required" });

    await h.handler(cli(["layout", "pane", "tiled"]));
    expect(h.calls).toContainEqual(["layout", "pane", "tiled"]);

    const failing = makeHarness({ cmdTmuxLayout: async () => { throw new Error("layout boom"); } });
    expect(await failing.handler(cli(["layout", "pane", "tiled"]))).toMatchObject({ ok: false, error: "layout boom" });
  });

  test("routes pipe and sync help, validation, and options", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["pipe", "--help"]))).output).toContain("pipe-pane");
    expect(await h.handler(cli(["pipe"]))).toMatchObject({ ok: false, error: "target required" });

    await h.handler(cli(["pipe-pane", "pane", "cat", ">", "/tmp/fifo", "--input", "--only-if-closed"]));
    expect(h.calls).toContainEqual(["pipe", "pane", "cat > /tmp/fifo", { input: true, output: undefined, onlyIfClosed: true }]);

    expect(await h.handler(cli(["pipe", "pane", "--no-output"]))).toMatchObject({ ok: false, error: "--no-output requires --input" });

    await h.handler(cli(["pipe", "pane", "cat", "--input", "--no-output"]));
    expect(h.calls).toContainEqual(["pipe", "pane", "cat", { input: true, output: false, onlyIfClosed: false }]);

    expect((await h.handler(cli(["sync", "--help"]))).output).toContain("synchronize-panes");
    expect(await h.handler(cli(["sync", "pane"]))).toMatchObject({ ok: false, error: "target and on/off required" });

    await h.handler(cli(["synchronize-panes", "pane", "on"]));
    await h.handler(cli(["sync", "pane", "0"]));
    expect(h.calls).toContainEqual(["sync", "pane", true]);
    expect(h.calls).toContainEqual(["sync", "pane", false]);
  });

  test("routes attach help, validation, print option, and readonly option", async () => {
    const h = makeHarness();
    expect((await h.handler(cli(["attach", "--help"]))).output).toContain("--readonly");
    expect(await h.handler(cli(["attach"]))).toMatchObject({ ok: false, error: "target required" });

    await h.handler(cli(["attach", "pane", "--print", "--readonly"]));
    expect(h.calls).toContainEqual(["attach", "pane", { print: true, readonly: true }]);
  });

  test("close/unsplit require tmux and hide sibling panes", async () => {
    const outside = makeHarness();
    delete process.env.TMUX;
    expect(await outside.handler(cli(["close"]))).toMatchObject({ ok: false, error: "not in tmux" });

    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%1";
    const onePane = makeHarness({ hostExec: async (cmd: string) => {
      onePane.calls.push(["hostExec", cmd]);
      return "%1\n";
    } });
    expect(await onePane.handler(cli(["unsplit"]))).toMatchObject({ ok: true });

    const h = makeHarness({ hostExec: async (cmd: string) => {
      h.calls.push(["hostExec", cmd]);
      if (cmd.includes("list-panes")) return "%1\n%2\n%3\n";
      if (cmd.includes("%3")) throw new Error("gone");
      return "";
    } });
    const result = await h.handler(cli(["close"]));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("closed 1 pane");
    expect(h.calls.some((c) => String(c[1]).includes("%2"))).toBe(true);
  });

  test("open requires tmux, restores hidden panes, and delegates target opens to split", async () => {
    const outside = makeHarness();
    delete process.env.TMUX;
    expect(await outside.handler(cli(["open"]))).toMatchObject({ ok: false, error: "not in tmux" });

    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%1";
    const noneWritten: string[] = [];
    const none = makeHarness({ hostExec: async (cmd: string) => {
      none.calls.push(["hostExec", cmd]);
      if (cmd.includes("display-message")) return "0\n";
      if (cmd.includes("list-windows")) return "0:2\n1:2\n";
      return "";
    } });
    expect(await none.handler(cli(["open"], (...a) => noneWritten.push(a.map(String).join(" "))))).toMatchObject({ ok: true });
    expect(noneWritten.join("\n")).toContain("no hidden panes");

    const h = makeHarness({ hostExec: async (cmd: string) => {
      h.calls.push(["hostExec", cmd]);
      if (cmd.includes("display-message")) return "0\n";
      if (cmd.includes("list-windows")) return "0:2\n1:1\n2:1\n";
      return "";
    } });
    const opened = await h.handler(cli(["open"]));
    expect(opened.ok).toBe(true);
    expect(opened.output).toContain("opened 0 hidden panes");

    const target = makeHarness();
    await target.handler(cli(["open", "mawjs"]));
    expect(target.calls).toContainEqual(["cmdSplit", "mawjs", { lock: true }]);
  });

  test("zoom validates target and resolves before resizing", async () => {
    const h = makeHarness();
    expect(await h.handler(cli(["zoom"]))).toMatchObject({ ok: false, error: "target required" });

    await h.handler(cli(["zoom", "pane"]));
    expect(h.calls).toContainEqual(["hostExec", "tmux resize-pane -Z -t 'resolved-pane'"]);

    const fallback = makeHarness({ resolveTmuxTarget: () => null });
    await fallback.handler(cli(["zoom", "raw"]));
    expect(fallback.calls).toContainEqual(["hostExec", "tmux resize-pane -Z -t 'raw'"]);
  });

  test("unknown subcommands fail and writer receives console output", async () => {
    const written: string[] = [];
    const h = makeHarness({
      cmdTmuxPeek: async () => { console.error("peek note"); },
    });
    const unknown = await h.handler(cli(["wat"]));
    expect(unknown).toMatchObject({ ok: false, error: "unknown subcommand: wat" });

    const writerResult = await h.handler(cli(["peek", "pane"], (...a) => written.push(a.map(String).join(" "))));
    expect(writerResult).toEqual({ ok: true, output: undefined });
    expect(written).toContain("peek note");
  });
});
