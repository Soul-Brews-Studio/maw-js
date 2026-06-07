import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/panes");

let sessions: any[];
let hostExecCalls: string[];
let hostExecResult: string;
let hostExecError: unknown;
let tmuxBin: string;

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  listSessions: async () => sessions,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (hostExecError) throw hostExecError;
    return hostExecResult;
  },
  tmuxCmd: () => tmuxBin,
  resolveSessionTarget: (target: string, rows: any[]) => {
    const exact = rows.find((row) => row.name === target);
    if (exact) return { kind: "exact", match: exact };
    const suffix = rows.filter((row) => row.name.endsWith(`-${target}`));
    if (suffix.length === 1) return { kind: "fuzzy", match: suffix[0] };
    if (suffix.length > 1) return { kind: "ambiguous", candidates: suffix };
    const hints = rows.filter((row) => row.name.includes(target));
    return { kind: "none", hints };
  },
  parseFlags: (args: string[], spec: Record<string, unknown> = {}) => {
    const out: Record<string, any> = { _: [] };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const kind = spec[arg];
      if (arg.startsWith("-") && kind !== undefined) {
        const key = typeof kind === "string" ? kind : arg;
        if (kind === Boolean || typeof kind === "string") out[key] = true;
        else if (kind === Number) out[key] = Number(args[++i]);
        else out[key] = args[++i];
      } else {
        out._.push(arg);
      }
    }
    return out;
  },
}));

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

function loadPanesPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadPanesPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

const { cmdPanes } = await import("../../src/vendor/mpr-plugins/panes/impl.ts?plugin-panes-standalone");

beforeEach(() => {
  sessions = [];
  hostExecCalls = [];
  hostExecResult = "alpha:0.0|||80x24|||zsh|||main\nalpha:0.1|||80x24|||codex|||agent";
  hostExecError = null;
  tmuxBin = "tmux-test";
});

describe("panes plugin standalone boundary", () => {
  test("plugin sources stay off direct core/shared/lib/config/cli imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/") || spec.startsWith("maw-js/cli/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk"]));
  });

  test("plugin loads from manifest and reports CLI metadata", async () => {
    const plugin = loadPanesPlugin();
    expect(plugin.manifest.name).toBe("panes");

    const result = await invokePlugin(plugin, { source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panes v1.0.0");
    expect(result.output).toContain("maw panes");
  });

  test("default command lists current panes without resolving sessions", async () => {
    const { result, output } = await invokeCli([]);

    expect(result.ok).toBe(true);
    expect(hostExecCalls).toEqual(["tmux-test list-panes  -F '#{session_name}:#{window_index}.#{pane_index}|||#{pane_width}x#{pane_height}|||#{pane_current_command}|||#{pane_title}'"]);
    expect(output).toContain("TARGET");
    expect(output).toContain("alpha:0.1");
    expect(output).toContain("codex");
  });

  test("all mode ignores target and includes pid column", async () => {
    hostExecResult = "alpha:0.0|||80x24|||zsh|||main|||123";

    const { result, output } = await invokeCli(["alpha", "--all", "--pid"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("--all ignores target argument");
    expect(output).toContain("PID");
    expect(output).toContain("123");
    expect(hostExecCalls[0]).toContain("list-panes -a");
    expect(hostExecCalls[0]).toContain("#{pane_pid}");
  });

  test("bare target resolves session-wide list panes", async () => {
    sessions = [{ name: "17-alpha", windows: [{ index: 0 }] }];

    const { result } = await invokeCli(["alpha"]);

    expect(result.ok).toBe(true);
    expect(hostExecCalls[0]).toContain("-s -t '17-alpha'");
  });

  test("colon target resolves only the session part", async () => {
    sessions = [{ name: "17-alpha", windows: [{ index: 0 }] }];

    await cmdPanes("alpha:2", { pid: true });

    expect(hostExecCalls[0]).toContain("-s -t '17-alpha:2'");
    expect(hostExecCalls[0]).toContain("#{pane_pid}");
  });

  test("missing and ambiguous targets surface resolver guidance", async () => {
    sessions = [{ name: "one-alpha" }, { name: "two-alpha" }, { name: "alphaish" }];

    await expect(cmdPanes("alpha")).rejects.toThrow("ambiguous");
    sessions = [{ name: "alphaish" }];
    await expect(cmdPanes("alp")).rejects.toThrow("session 'alp' not found");
  });

  test("empty output and host errors are handled", async () => {
    hostExecResult = "";
    let ok = await invokeCli([]);
    expect(ok.result.ok).toBe(true);
    expect(ok.output).toContain("(no panes)");

    hostExecError = new Error("tmux down");
    ok = await invokeCli([]);
    expect(ok.result.ok).toBe(false);
    expect(ok.result.error).toContain("list-panes failed: tmux down");
  });
});
