import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/awaken");
const budImplPath = "../../src/vendor/mpr-plugins/bud/impl";
const sendTextImplPath = "../../src/vendor/mpr-plugins/send-text/impl";

let budCalls: Array<{ name: string; opts: Record<string, unknown> }>;
let sendTextCalls: Array<{ target: string; text: string }>;
let sessions: unknown[];
let paneCommands: string[];
let resolveResult: unknown;
let config: Record<string, unknown>;

function mockBoth(spec: string, factory: () => Record<string, unknown>) {
  mock.module(import.meta.resolve(spec), factory);
  mock.module(import.meta.resolve(`${spec}.ts`), factory);
}

mockBoth(budImplPath, () => ({
  cmdBud: async (name: string, opts: Record<string, unknown>) => {
    budCalls.push({ name, opts });
    if (opts.root && opts.dryRun) {
      const org = String(opts.org ?? "Soul-Brews-Studio");
      console.log(`🌱 Root Bud: ${name} → ${org}/${name}-oracle`);
      console.log(`[dry-run] would create repo: ${org}/${name}-oracle`);
      if (opts.nickname) console.log(`[dry-run] would write nickname: ${opts.nickname}`);
    }
  },
}));

mockBoth(sendTextImplPath, () => ({
  parseSendTextArgs: (args: string[]) => {
    const target = args[0];
    const text = args.slice(1).join(" ");
    if (!target) throw new Error("target is required");
    if (!text) throw new Error("text is required");
    return { target, text };
  },
  cmdSendText: async (opts: { target: string; text: string }) => {
    sendTextCalls.push(opts);
    const sdk = await import("maw-js/sdk");
    const resolved = sdk.resolveTarget?.(opts.target);
    if (resolved?.type === "peer") {
      await sdk.curlFetch?.(`${resolved.peerUrl}/api/pane-keys`, {
        method: "POST",
        body: JSON.stringify({ target: resolved.target, text: opts.text, enter: true }),
      });
      return;
    }
    if (sdk.Tmux && sdk.resolveOraclePane) {
      const pane = await sdk.resolveOraclePane(resolved?.target ?? opts.target);
      const tmux = new sdk.Tmux();
      if (typeof tmux.sendText === "function") await tmux.sendText(pane, opts.text);
      console.log(`sent → ${pane}: ${opts.text}`);
    }
  },
}));

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  listSessions: async () => sessions,
  resolveTarget: () => resolveResult,
  resolveOraclePane: async (target: string) => target,
  Tmux: class {
    async sendText(_pane: string, _text: string) {}
  },
  getPaneCommand: async () => paneCommands.shift() ?? "codex",
  isAgentCommand: (command: string | null | undefined) => ["codex", "claude"].includes(String(command ?? "")),
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
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

function loadAwakenPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadAwakenPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

beforeEach(() => {
  budCalls = [];
  sendTextCalls = [];
  sessions = [{ name: "spark-oracle" }];
  paneCommands = ["zsh", "codex"];
  resolveResult = { type: "local", target: "spark:spark-oracle" };
  config = { node: "m5" };
} );

describe("awaken plugin standalone coverage (#2220)", () => {
  test("plugin sources stay off direct core imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining([
      "maw-js/plugin/types",
      "maw-js/cli/parse-args",
      "maw-js/sdk",
      "maw-js/config",
      "../bud/impl",
      "../send-text/impl",
    ]));
  });

  test("plugin loads from manifest and reports CLI usage", async () => {
    const plugin = loadAwakenPlugin();
    const metadata = await invokePlugin(plugin, { source: "cli", args: ["--help"] });
    expect(metadata.ok).toBe(true);
    expect(metadata.output || "").toContain("awaken v1.0.0");

    const { result } = await invokeCli([]);
    expect(result.ok).toBe(false);
    expect(result.error || "").toContain("usage: maw awaken");
  });

  test("dry-run buds and reports planned trigger without resolving panes", async () => {
    const { result, output } = await invokeCli(["spark", "--dry-run", "--from", "root", "--trigger", "/awaken --fast"]);

    expect(result.ok).toBe(true);
    expect(budCalls).toEqual([{ name: "spark", opts: expect.objectContaining({ dryRun: true, from: "root", trigger: "/awaken --fast" }) }]);
    expect(sendTextCalls).toEqual([]);
    expect(output).toContain("[dry-run] would send");
    expect(output).toContain("/awaken --fast");
  });

  test("no-trigger skips sending after bud", async () => {
    const { result, output } = await invokeCli(["spark", "--no-trigger", "--yes"]);

    expect(result.ok).toBe(true);
    expect(budCalls).toEqual([{ name: "spark", opts: expect.objectContaining({ noTrigger: true, yes: true }) }]);
    expect(sendTextCalls).toEqual([]);
    expect(output).toContain("--no-trigger: bud + wake done");
  });

  test("resolves ready agent pane and sends the awaken trigger", async () => {
    const { result, output } = await invokeCli(["spark", "--yes"]);

    expect(result.ok).toBe(true);
    expect(budCalls).toEqual([{ name: "spark", opts: expect.objectContaining({ yes: true }) }]);
    expect(sendTextCalls).toEqual([{ target: "spark", text: "/awaken" }]);
    expect(output).toContain("firing");
    expect(output).toContain("awakened");
  });

  test("unresolved target reports manual send guidance", async () => {
    resolveResult = { type: "error", message: "missing" };
    const { result, output } = await invokeCli(["spark", "--yes"]);

    expect(result.ok).toBe(true);
    expect(sendTextCalls).toEqual([]);
    expect(output).toContain("could not resolve spark after wake");
    expect(output).toContain("try manually: maw send-text spark /awaken");
  });
});
