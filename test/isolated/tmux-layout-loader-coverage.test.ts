import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const realSdk = await import("../../src/sdk");

let hostCommands: string[] = [];
let paneHeights = "12\n12\n12";
let paneIds = "%leader\n%spawned";
let splitPaneId = "%spawned\n";
let windowId = "@win";
let hostFailures: string[] = [];
let lockEntries = 0;
let originalTmuxPane: string | undefined;

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string) => {
    hostCommands.push(cmd);
    const failure = hostFailures.find((needle) => cmd.includes(needle));
    if (failure) throw new Error(`forced hostExec failure for ${failure}`);
    if (cmd.includes("split-window")) return splitPaneId;
    if (cmd.includes("display-message")) return windowId;
    if (cmd.includes("#{pane_id}")) return paneIds;
    if (cmd.includes("#{pane_height}")) return paneHeights;
    return "";
  },
  withPaneLock: async <T>(fn: () => Promise<T>) => {
    lockEntries++;
    return fn();
  },
}));

const layout = await import("../../src/commands/plugins/tmux/layout-manager");
const { PluginSystem } = await import("../../src/plugins/10_system");
const { loadPlugins, reloadUserPlugins } = await import("../../src/plugins/20_loader");

type LoaderGlobals = typeof globalThis & {
  __mawLoaderEvents?: unknown[];
  __mawLoaderTeardowns?: string[];
};

let tempDir = "";
let errorSpy: ReturnType<typeof spyOn>;

function loaderGlobals(): LoaderGlobals {
  return globalThis as LoaderGlobals;
}

function writePluginFile(name: string, source: string): void {
  writeFileSync(join(tempDir, name), source, "utf-8");
}

function writeWasmFile(name: string, bytes: number[]): void {
  writeFileSync(join(tempDir, name), Buffer.from(bytes));
}

function event(name = "brewed", extra: Record<string, unknown> = {}) {
  return {
    event: name,
    oracle: "oracle-test",
    host: "host-test",
    ts: "2026-05-18T00:00:00.000Z",
    ...extra,
  } as any;
}

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function ascii(text: string): number[] {
  return [...Buffer.from(text, "utf-8")];
}

function str(text: string): number[] {
  return [...u32(Buffer.byteLength(text)), ...ascii(text)];
}

function i32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function wasmModule(sections: number[][]): number[] {
  return [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()];
}

function sharedMemoryWasm(opts: { memoryPages?: number; trap?: boolean } = {}): number[] {
  const memoryPages = opts.memoryPages ?? 1;
  return wasmModule([
    // type: (func (param i32 i32))
    section(1, [0x01, 0x60, 0x02, 0x7f, 0x7f, 0x00]),
    // function: one function with type 0
    section(3, [0x01, 0x00]),
    // memory: one exported memory with configurable initial pages
    section(5, [0x01, 0x00, ...u32(memoryPages)]),
    // exports: memory + handle
    section(7, [
      0x02,
      0x06, ...ascii("memory"), 0x02, 0x00,
      0x06, ...ascii("handle"), 0x00, 0x00,
    ]),
    // code: no-op handle, or a trapping handle to exercise trap logging
    section(10, opts.trap ? [0x01, 0x03, 0x00, 0x00, 0x0b] : [0x01, 0x02, 0x00, 0x0b]),
  ]);
}

function wasiStartWasm(): number[] {
  return wasmModule([
    // type: (func)
    section(1, [0x01, 0x60, 0x00, 0x00]),
    section(3, [0x01, 0x00]),
    section(7, [0x01, 0x06, ...ascii("_start"), 0x00, 0x00]),
    section(10, [0x01, 0x02, 0x00, 0x0b]),
  ]);
}

function wasiStdioWasm(): number[] {
  const memory = new Array<number>(80).fill(0);
  memory.splice(0, 8, ...i32(32), ...i32(4));
  memory.splice(8, 8, ...i32(48), ...i32(4));
  memory.splice(16, 8, ...i32(64), ...i32(8));
  memory.splice(32, 4, ...ascii("out\n"));
  memory.splice(48, 4, ...ascii("err\n"));

  const startBody = [
    0x00,
    0x41, 0x00, 0x41, 0x10, 0x41, 0x01, 0x41, 0x1c, 0x10, 0x01, 0x1a,
    0x41, 0x01, 0x41, 0x00, 0x41, 0x01, 0x41, 0x1c, 0x10, 0x00, 0x1a,
    0x41, 0x02, 0x41, 0x08, 0x41, 0x01, 0x41, 0x1c, 0x10, 0x00, 0x1a,
    0x0b,
  ];

  return wasmModule([
    section(1, [
      0x02,
      0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
      0x60, 0x00, 0x00,
    ]),
    section(2, [
      0x02,
      ...str("wasi_snapshot_preview1"), ...str("fd_write"), 0x00, 0x00,
      ...str("wasi_snapshot_preview1"), ...str("fd_read"), 0x00, 0x00,
    ]),
    section(3, [0x01, 0x01]),
    section(5, [0x01, 0x00, 0x01]),
    section(7, [
      0x02,
      ...str("_start"), 0x00, 0x02,
      ...str("memory"), 0x02, 0x00,
    ]),
    section(10, [0x01, ...u32(startBody.length), ...startBody]),
    section(11, [0x01, 0x00, 0x41, 0x00, 0x0b, ...u32(memory.length), ...memory]),
  ]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "maw-layout-loader-"));
  hostCommands = [];
  paneHeights = "12\n12\n12";
  paneIds = "%leader\n%spawned";
  splitPaneId = "%spawned\n";
  windowId = "@win";
  hostFailures = [];
  lockEntries = 0;
  originalTmuxPane = process.env.TMUX_PANE;
  delete process.env.TMUX_PANE;
  loaderGlobals().__mawLoaderEvents = [];
  loaderGlobals().__mawLoaderTeardowns = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
  errorSpy.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
  delete loaderGlobals().__mawLoaderEvents;
  delete loaderGlobals().__mawLoaderTeardowns;
});

describe("tmux layout-manager focused branch coverage", () => {
  test("cycles agent colors and exposes ANSI foreground codes", () => {
    expect(layout.nextAgentColor(0)).toBe("blue");
    expect(layout.nextAgentColor(7)).toBe("orange");
    expect(layout.nextAgentColor(8)).toBe("blue");
    expect(layout.colorAnsi("orange")).toBe("38;5;208");
    expect(layout.colorAnsi("white")).toBe("37");
  });

  test("applies main/tiled layout commands and pane border styling", async () => {
    await layout.applyTeamLayout("@team", "%leader", 42);
    await layout.rebalanceAfterSpawn("@team", "%leader");
    await layout.applyTiledLayout("@team");
    await layout.stylePaneBorder("%agent", "helper", "magenta");

    expect(hostCommands).toEqual([
      "tmux select-layout -t '@team' main-vertical",
      "tmux resize-pane -t '%leader' -x 42%",
      "tmux select-layout -t '@team' main-vertical",
      "tmux resize-pane -t '%leader' -x 30%",
      "tmux select-layout -t '@team' tiled",
      "tmux select-pane -t '%agent' -T 'helper'",
      "tmux set-option -p -t '%agent' pane-border-format '#[fg=magenta,bold] #{pane_title}'",
      "tmux set-option -p -t '%agent' pane-active-border-style 'fg=magenta'",
    ]);
  });

  test("hide/show helpers report hostExec failures without throwing", async () => {
    expect(await layout.hidePane("%hidden")).toBe(true);
    expect(await layout.showPane("%hidden", "%leader")).toBe(true);

    hostFailures = ["break-pane"];
    expect(await layout.hidePane("%missing")).toBe(false);

    hostFailures = ["join-pane"];
    expect(await layout.showPane("%missing", "%leader")).toBe(false);

    expect(hostCommands).toEqual([
      "tmux break-pane -d -t '%hidden'",
      "tmux join-pane -h -s '%hidden' -t '%leader'",
      "tmux break-pane -d -t '%missing'",
      "tmux join-pane -h -s '%missing' -t '%leader'",
    ]);
  });

  test("cleanup skips the leader, counts successes, and ignores vanished panes", async () => {
    hostFailures = ["%gone"];
    await expect(layout.cleanupTeamPanes("%leader", ["%leader", "%one", "%gone"])).resolves.toBe(1);

    hostFailures = [];
    await expect(layout.cleanupTeamPanes("%leader", ["%two"], { hide: true })).resolves.toBe(1);

    expect(hostCommands).toEqual([
      "tmux kill-pane -t '%one'",
      "tmux kill-pane -t '%gone'",
      "tmux break-pane -d -t '%two'",
    ]);
  });

  test("spawnTeammatePane locks split, styles the pane, rebalances, and enables safe border status", async () => {
    paneIds = "%leader\n%spawned\n%third";
    paneHeights = "9\n9\n9";
    windowId = "@42";

    const result = await layout.spawnTeammatePane("helper", "echo teammate", {
      colorIndex: 9,
      leaderPane: "%leader",
    });

    expect(result).toEqual({ paneId: "%spawned", color: "green", isFirst: false });
    expect(lockEntries).toBe(1);
    expect(hostCommands[0]).toContain("tmux split-window -t '%leader' -h -P -F '#{pane_id}'");
    expect(hostCommands[0]).toContain("'echo teammate; printf \"\\e[?1049l\"; clear; exec zsh -li'");
    expect(hostCommands).toContain("tmux display-message -p '#{window_id}'");
    expect(hostCommands).toContain("tmux list-panes -t '@42' -F '#{pane_id}'");
    expect(hostCommands).toContain("tmux select-layout -t '@42' main-vertical");
    expect(hostCommands).toContain("tmux resize-pane -t '%leader' -x 30%");
    expect(hostCommands).toContain("tmux select-pane -t '%spawned' -T 'helper'");
    expect(hostCommands).toContain(
      "tmux set-option -p -t '%spawned' pane-border-format '#[fg=green,bold] #{pane_title}'",
    );
    expect(hostCommands).toContain("tmux set-option -w -t '@42' pane-border-status bottom");
  });
});

describe("plugin loader focused branch coverage", () => {
  test("missing plugin directories fail soft", async () => {
    const system = new PluginSystem();

    await loadPlugins(system, join(tempDir, "missing"));

    expect(system.stats().plugins).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("loads callable js/ts plugins, ignores non-functions, and reports import failures", async () => {
    const system = new PluginSystem();
    writePluginFile(
      "alpha.js",
      "export default function(hooks) { hooks.on('*', (event) => globalThis.__mawLoaderEvents.push(['alpha', event.event])); }",
    );
    writePluginFile(
      "beta.ts",
      "export default function(hooks: any) { hooks.late('*', (event: any) => globalThis.__mawLoaderEvents.push(['beta', event.event])); }",
    );
    writePluginFile("ignored.js", "export default { not: 'callable' };");
    writePluginFile("throws.js", "throw new Error('boom plugin import');");
    writePluginFile("README.md", "not a plugin");

    await loadPlugins(system, tempDir, "builtin");
    await system.emit(event("coffee"));

    expect(system.stats().plugins.map((plugin) => [plugin.name, plugin.type, plugin.source]).sort()).toEqual([
      ["alpha.js", "js", "builtin"],
      ["beta.ts", "ts", "builtin"],
    ]);
    expect(loaderGlobals().__mawLoaderEvents).toEqual([
      ["alpha", "coffee"],
      ["beta", "coffee"],
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[plugin] failed to load throws.js:",
      "boom plugin import",
    );
  });

  test("reloadUserPlugins unloads user scope, cache-busts reload, and preserves builtin hooks", async () => {
    const system = new PluginSystem();
    const builtinEvents: string[] = [];
    system.load((hooks) => {
      hooks.on("*", (evt) => builtinEvents.push(evt.event));
    }, "builtin", "builtin.js");
    system.register("builtin.js", "js", "builtin");
    system.load(() => () => loaderGlobals().__mawLoaderTeardowns?.push("old-user"), "user", "old.js");
    system.register("old.js", "js", "user");
    writePluginFile(
      "fresh.js",
      [
        "export default function(hooks) {",
        "  hooks.on('*', (event) => globalThis.__mawLoaderEvents.push(['fresh', event.event]));",
        "  return () => globalThis.__mawLoaderTeardowns.push('fresh-user');",
        "}",
      ].join("\n"),
    );

    await reloadUserPlugins(system, tempDir);
    await system.emit(event("reload"));

    const stats = system.stats();
    expect(stats.reloads).toBe(1);
    expect(stats.plugins.map((plugin) => [plugin.name, plugin.source]).sort()).toEqual([
      ["builtin.js", "builtin"],
      ["fresh.js", "user"],
    ]);
    expect(loaderGlobals().__mawLoaderTeardowns).toEqual(["old-user"]);
    expect(builtinEvents).toEqual(["reload"]);
    expect(loaderGlobals().__mawLoaderEvents).toEqual([["fresh", "reload"]]);
  });

  test("loads shared-memory wasm plugins and skips events too large for wasm memory", async () => {
    const system = new PluginSystem();
    writeWasmFile("shared.wasm", sharedMemoryWasm());

    await loadPlugins(system, tempDir, "user");
    await system.emit(event("small"));
    await system.emit(event("large", { payload: "x".repeat(70_000) }));

    expect(system.stats().plugins.map((plugin) => [plugin.name, plugin.type, plugin.source])).toEqual([
      ["shared.wasm", "wasm-shared", "user"],
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("logs shared-memory wasm traps and rejects excessive initial memory", async () => {
    const system = new PluginSystem();
    writeWasmFile("huge.wasm", sharedMemoryWasm({ memoryPages: 257 }));
    writeWasmFile("trap.wasm", sharedMemoryWasm({ trap: true }));

    await loadPlugins(system, tempDir, "user");
    await system.emit(event("trap"));

    expect(system.stats().plugins.map((plugin) => [plugin.name, plugin.type])).toEqual([
      ["trap.wasm", "wasm-shared"],
    ]);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("wasm rejected: huge.wasm"))).toBe(true);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("wasm trap in trap.wasm"))).toBe(true);
  });

  test("registers WASI wasm plugins and reports invalid wasm import failures", async () => {
    const system = new PluginSystem();
    writeWasmFile("wasi.wasm", wasiStartWasm());
    writeWasmFile("invalid.wasm", [0x00, 0x61, 0x73, 0x6d]);

    await loadPlugins(system, tempDir, "builtin");
    await system.emit(event("wasi-event"));

    expect(system.stats().plugins.map((plugin) => [plugin.name, plugin.type, plugin.source])).toEqual([
      ["wasi.wasm", "wasm-wasi", "builtin"],
    ]);
    expect(errorSpy.mock.calls.some((call) => (
      call[0] === "[plugin] failed to load invalid.wasm:" && String(call[1]).length > 0
    ))).toBe(true);
  });

  test("WASI wasm stdio adapters handle stdin, stdout, and stderr callbacks", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const system = new PluginSystem();
      writeWasmFile("stdio.wasm", wasiStdioWasm());

      await loadPlugins(system, tempDir, "user");
      await system.emit(event("stdio"));

      expect(system.stats().plugins.map((plugin) => [plugin.name, plugin.type, plugin.source])).toEqual([
        ["stdio.wasm", "wasm-wasi", "user"],
      ]);
      expect(stdoutChunks.join("")).toContain("out");
      expect(stderrChunks.join("")).toContain("err");
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
  });
});
