import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/pr");
const originalSpawn = Bun.spawn;
const originalTmux = process.env.TMUX;

let tmuxCalls: string[][] = [];
let spawnCalls: Array<{ argv: string[]; opts: Record<string, unknown> }> = [];
let branchName = "agents/issue-2285-pr-standalone";
let ghOutput = "https://github.com/Soul-Brews-Studio/maw-js/pull/9999\n";
let ghExit = 0;

class MockTmux {
  async run(...args: string[]) {
    tmuxCalls.push(args);
    const joined = args.join(" ");
    if (joined.includes("#{session_name}")) return "alpha\n";
    if (joined.includes("#{pane_current_path}")) return "/tmp/maw-js\n";
    return "";
  }
}

mock.module("maw-js/sdk", () => ({ ...realSdk, Tmux: MockTmux }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, Tmux: MockTmux }));

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function mockSpawn(argv: string[], opts: Record<string, unknown>) {
  spawnCalls.push({ argv, opts });
  if (argv[0] === "git") {
    return { stdout: textStream(`${branchName}\n`), stderr: textStream(""), exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
  }
  if (argv[0] === "gh") {
    return { stdout: textStream(ghOutput), stderr: textStream(""), exited: Promise.resolve(ghExit) } as ReturnType<typeof Bun.spawn>;
  }
  return { stdout: textStream(""), stderr: textStream(""), exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...walkSources(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [importFrom, importFn, requireFn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }

  return [...specs];
}

function loadPrPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

beforeEach(() => {
  tmuxCalls = [];
  spawnCalls = [];
  branchName = "agents/issue-2285-pr-standalone";
  ghOutput = "https://github.com/Soul-Brews-Studio/maw-js/pull/9999\n";
  ghExit = 0;
  process.env.TMUX = "/tmp/tmux.sock";
  Bun.spawn = mockSpawn as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

describe("pr plugin standalone boundary (#2285)", () => {
  test("imports runtime dependencies only through the SDK boundary", () => {
    const imports = walkSources(pluginDir).flatMap((file) => parseImportSpecs(readFileSync(file, "utf8")));

    const disallowed = imports.filter((spec) => {
      if (spec.startsWith(".")) return false;
      return spec !== "maw-js/sdk";
    });

    expect(disallowed).toEqual([]);
    expect(imports).toContain("maw-js/sdk");
  });

  test("plugin loads and creates an issue-linked PR via SDK tmux and Bun.spawn", async () => {
    const out: string[] = [];
    const result = await invokePlugin(loadPrPlugin(), {
      source: "cli",
      args: [],
      writer: (...args: unknown[]) => out.push(args.map(String).join(" ")),
    });

    expect(result.ok).toBe(true);
    expect(tmuxCalls).toEqual([["display-message", "-p", "#{pane_current_path}"]]);
    expect(spawnCalls).toEqual([
      { argv: ["git", "-C", "/tmp/maw-js", "branch", "--show-current"], opts: expect.objectContaining({ stdout: "pipe", stderr: "pipe" }) },
      { argv: ["gh", "pr", "create", "--title", "Issue 2285 Pr Standalone", "--body", "Closes #2285"], opts: expect.objectContaining({ cwd: "/tmp/maw-js" }) },
    ]);
    expect(out.join("\n")).toContain("creating PR");
    expect(out.join("\n")).toContain("https://github.com/Soul-Brews-Studio/maw-js/pull/9999");
  });

  test("window argument resolves cwd through session/window target", async () => {
    const result = await invokePlugin(loadPrPlugin(), { source: "cli", args: ["worker"] });

    expect(result.ok).toBe(true);
    expect(tmuxCalls).toEqual([
      ["display-message", "-p", "#{session_name}"],
      ["display-message", "-t", "alpha:worker", "-p", "#{pane_current_path}"],
    ]);
  });

  test("missing tmux returns InvokeResult error without spawning", async () => {
    delete process.env.TMUX;

    const result = await invokePlugin(loadPrPlugin(), { source: "cli", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not in a tmux session");
    expect(spawnCalls).toEqual([]);
  });

  test("gh failure becomes InvokeResult error", async () => {
    ghExit = 7;

    const result = await invokePlugin(loadPrPlugin(), { source: "cli", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("gh pr create failed (exit 7)");
  });
});
