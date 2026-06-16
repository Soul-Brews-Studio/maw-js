import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/completions");

let fleet: Array<{ windows?: Array<{ name?: string }> }>;
let plugins: Array<{
  disabled?: boolean;
  kind: "ts" | "wasm";
  entryPath?: string;
  wasmPath?: string;
  manifest: { name: string; cli?: { command: string; aliases?: string[] } };
}>;

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => fleet,
  loadFleetEntries: () => fleet,
  resolveFleetSession: () => null,
  loadDisabledFleetEntries: () => [],
  countDisabledFleetFiles: () => 0,
  fleetDirForWrite: () => "",
  fleetDirsForRead: () => [],
}));

mock.module("maw-js/plugin/registry", () => ({
  discoverPackages: () => plugins,
  invokePlugin: async () => ({ ok: true }),
  importPluginSymbol: async () => undefined,
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

function loadCompletionsPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadCompletionsPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

beforeEach(() => {
  fleet = [
    { windows: [{ name: "alpha-oracle" }, { name: "alpha-shell" }] },
    { windows: [{ name: "beta-oracle" }, { name: "beta-codex" }, {}] },
  ];
  plugins = [
    { kind: "ts", entryPath: "/plugins/ask/index.ts", manifest: { name: "ask", cli: { command: "ask", aliases: ["ask-ai"] } } },
    { kind: "ts", entryPath: "/plugins/no-cli/index.ts", manifest: { name: "no-cli" } },
    { kind: "wasm", wasmPath: "/plugins/wasm.wasm", manifest: { name: "wasm-tool" } },
    { disabled: true, kind: "ts", entryPath: "/plugins/disabled/index.ts", manifest: { name: "disabled", cli: { command: "disabled" } } },
  ];
});

describe("completions plugin standalone coverage (#2183)", () => {
  test("plugin sources use package export boundaries, not relative core imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("../") || spec.startsWith("../../"))).toEqual([]);
    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/lib/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining([
      "maw-js/plugin/types",
      "maw-js/commands/shared/fleet-load",
      "maw-js/plugin/registry",
    ]));
  });

  test("plugin loads from manifest and --help works", async () => {
    const plugin = loadCompletionsPlugin();
    const metadata = await invokePlugin(plugin, { source: "cli", args: ["--help"] });
    expect(metadata.ok).toBe(true);
    expect(metadata.output || "").toContain("completions v1.0.0");

    const { result, output } = await invokeCli(["help"]);
    expect(result.ok).toBe(true);
    expect(output).toContain("usage: maw completions");
    expect(output).toContain("zsh");
  });

  test("commands include core commands plus discovered plugin CLI names", async () => {
    const { result, output } = await invokeCli(["commands"]);

    expect(result.ok).toBe(true);
    const words = output.split(/\s+/).filter(Boolean);
    expect(words).toContain("hey");
    expect(words).toContain("wake");
    expect(words).toContain("ask");
    expect(words).toContain("ask-ai");
    expect(words).toContain("no-cli");
    expect(words).toContain("wasm-tool");
    expect(words).not.toContain("disabled");
  });

  test("oracles and windows are generated from fleet configs", async () => {
    const oracles = await invokeCli(["oracles"]);
    expect(oracles.result.ok).toBe(true);
    expect(oracles.output.split("\n")).toEqual(["alpha", "beta"]);

    const windows = await invokeCli(["windows"]);
    expect(windows.result.ok).toBe(true);
    expect(windows.output.split("\n")).toEqual(["alpha-oracle", "alpha-shell", "beta-codex", "beta-oracle"]);
  });

  test("shell completion and unknown mode paths return InvokeResult", async () => {
    const bash = await invokeCli(["bash"]);
    expect(bash.result.ok).toBe(true);
    expect(bash.output).toContain("complete -F _maw_complete maw");

    const unknown = await invokeCli(["powershell"]);
    expect(unknown.result.ok).toBe(false);
    expect(unknown.result.error || "").toContain("unknown completion mode: powershell");
    expect(unknown.output).toContain("usage: maw completions");
  });
});
