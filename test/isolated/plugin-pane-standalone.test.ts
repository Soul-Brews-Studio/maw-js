import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const swapCalls: Array<[string, string]> = [];
let swapError: Error | null = null;

const tileMock = {
  cmdTileSwap: async (a: string, b: string) => {
    swapCalls.push([a, b]);
    if (swapError) throw swapError;
  },
};

mock.module(import.meta.resolve("../../src/commands/plugins/tile/impl"), () => tileMock);
mock.module(import.meta.resolve("../../src/commands/plugins/tile/impl.ts"), () => tileMock);
mock.module(new URL("../../src/commands/plugins/tile/impl.ts", import.meta.url).pathname, () => tileMock);

const { default: paneHandler } = await import("../../src/commands/plugins/pane/index.ts?plugin-pane-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  swapCalls.length = 0;
  swapError = null;
  delete process.env.TMUX;
});

describe("pane command plugin standalone boundary", () => {
  test("uses only plugin types plus plugin-local tile import, with no SDK/core/shared/lib imports", () => {
    const source = readFileSync(join(root, "src/commands/plugins/pane/index.ts"), "utf8");

    expect(source).not.toMatch(/from\s+["'](?:maw-js\/|\.\.\/\.\.\/\.\.\/(?:sdk|core|commands\/shared|lib|config))/);
    expect(source).not.toMatch(/import\(["']\.\.\/\.\.\/\.\.\//);
    expect(source).toContain('from "../../../plugin/types"');
    expect(source).toContain('import("../tile/impl")');
  });

  test("rejects all actions outside tmux before parsing subcommands", async () => {
    const result = await paneHandler({ source: "cli", args: ["--help"] } as any);

    expect(result).toEqual({ ok: false, error: "not in tmux" });
    expect(swapCalls).toEqual([]);
  });

  test("prints usage inside tmux for missing subcommand and help forms", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";

    for (const args of [[], ["--help"], ["-h"]]) {
      const result = await paneHandler({ source: "cli", args } as any);

      expect(result.ok).toBe(true);
      const output = stripAnsi(result.output);
      expect(output).toContain("usage: maw pane swap <pane-a> <pane-b>");
      expect(output).toContain("pane targets: index (1), pane id (%1), title prefix (tile-1), top, bottom");
    }
    expect(swapCalls).toEqual([]);
  });

  test("reports unknown subcommands and missing swap targets", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";

    const unknown = await paneHandler({ source: "cli", args: ["move"] } as any);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toBe("unknown subcommand: move");
    expect(stripAnsi(unknown.output)).toContain("unknown pane subcommand: move");

    const missing = await paneHandler({ source: "cli", args: ["swap", "top"] } as any);
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("two pane targets required");
    expect(stripAnsi(missing.output)).toContain("usage: maw pane swap <pane-a> <pane-b>");
    expect(swapCalls).toEqual([]);
  });

  test("delegates swap targets to tile implementation", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";

    const result = await paneHandler({ source: "cli", args: ["swap", "top", "%3"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toBeUndefined();
    expect(swapCalls).toEqual([["top", "%3"]]);
  });

  test("surfaces tile swap failures without losing captured output", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    swapError = new Error("pane target not found");

    const result = await paneHandler({ source: "cli", args: ["swap", "top", "missing"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pane target not found");
    expect(swapCalls).toEqual([["top", "missing"]]);
  });
});
