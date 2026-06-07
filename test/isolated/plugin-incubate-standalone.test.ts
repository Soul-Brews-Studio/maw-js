import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/incubate");
const budImplPath = "../../src/vendor/mpr-plugins/bud/impl";
const sendTextImplPath = "../../src/vendor/mpr-plugins/send-text/impl";

let budCalls: Array<{ name: string; opts: Record<string, unknown> }>;
let sendTextCalls: Array<{ target: string; text: string }>;
let sessions: unknown[];
let config: Record<string, unknown>;
let resolveResult: unknown;

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
  loadConfig: () => config,
  listSessions: async () => sessions,
  resolveTarget: () => resolveResult,
  resolveOraclePane: async (target: string) => target,
  Tmux: class {
    async sendText(_pane: string, _text: string) {}
  },
  parseFlags: (args: string[], spec: Record<string, unknown> = {}) => {
    const out: Record<string, any> = { _: [] };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const kind = spec[arg];
      if (arg.startsWith("--") && kind !== undefined) {
        if (kind === Boolean) out[arg] = true;
        else if (kind === Number) out[arg] = Number(args[++i]);
        else out[arg] = args[++i];
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

function loadIncubatePlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadIncubatePlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

const { buildSkillCommand, deriveStemFromSource, resolveMode } = await import("../../src/vendor/mpr-plugins/incubate/impl.ts?plugin-incubate-standalone");

beforeEach(() => {
  budCalls = [];
  sendTextCalls = [];
  sessions = [{ name: "spark-oracle" }];
  config = { node: "m5" };
  resolveResult = { type: "local", target: "spark:spark-oracle" };
});

describe("incubate plugin standalone boundary (#2249)", () => {
  test("plugin sources stay off direct core/shared/lib/config/cli imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/") || spec.startsWith("maw-js/cli/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk", "../bud/impl", "../send-text/impl"]));
  });

  test("pure helpers derive stems, commands, and mutually exclusive modes", () => {
    expect(deriveStemFromSource("Soul-Brews-Studio/foo")).toBe("foo");
    expect(deriveStemFromSource("https://github.com/org/foo.git")).toBe("foo");
    expect(buildSkillCommand({ source: "org/foo" })).toBe("/incubate org/foo");
    expect(buildSkillCommand({ source: "org/foo", mode: "flash" })).toBe("/incubate org/foo --flash");
    expect(buildSkillCommand({ source: "org/foo", mode: "contribute" })).toBe("/incubate org/foo --contribute");
    expect(buildSkillCommand({ source: "org/foo", trigger: "/custom" })).toBe("/custom");
    expect(resolveMode(false, false)).toBe("default");
    expect(resolveMode(true, false)).toBe("flash");
    expect(resolveMode(false, true)).toBe("contribute");
    expect(() => resolveMode(true, true)).toThrow("mutually exclusive");
  });

  test("plugin loads from manifest and reports usage", async () => {
    const plugin = loadIncubatePlugin();
    expect(plugin.manifest.name).toBe("incubate");

    const help = await invokePlugin(plugin, { source: "cli", args: ["--help"] });
    expect(help.ok).toBe(true);
    expect(help.output).toContain("incubate v2.0.0");

    const { result } = await invokeCli([]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw incubate");
  });

  test("dry-run buds derived stem with repo passthrough and reports planned trigger", async () => {
    const { result, output } = await invokeCli(["Soul-Brews-Studio/spark", "--dry-run", "--flash", "--from", "root", "--note", "seed it"]);

    expect(result.ok).toBe(true);
    expect(budCalls).toEqual([{ name: "spark", opts: expect.objectContaining({ repo: "Soul-Brews-Studio/spark", dryRun: true, from: "root", note: "seed it" }) }]);
    expect(sendTextCalls).toEqual([]);
    expect(output).toContain("[dry-run] would send");
    expect(output).toContain("/incubate Soul-Brews-Studio/spark --flash");
  });

  test("custom stem and no-trigger skip send after bud", async () => {
    const { result, output } = await invokeCli(["org/source", "--stem", "seedling", "--no-trigger"]);

    expect(result.ok).toBe(true);
    expect(budCalls).toEqual([{ name: "seedling", opts: expect.objectContaining({ repo: "org/source" }) }]);
    expect(sendTextCalls).toEqual([]);
    expect(output).toContain("--no-trigger: bud + wake done");
  });

  test("resolved new oracle receives incubate trigger", async () => {
    const { result, output } = await invokeCli(["org/spark", "--contribute"]);

    expect(result.ok).toBe(true);
    expect(budCalls).toEqual([{ name: "spark", opts: expect.objectContaining({ repo: "org/spark" }) }]);
    expect(sendTextCalls).toEqual([{ target: "spark", text: "/incubate org/spark --contribute" }]);
    expect(output).toContain("firing");
    expect(output).toContain("incubation dispatched");
  });

  test("unresolved new oracle prints manual send guidance", async () => {
    resolveResult = { type: "error", message: "missing" };

    const { result, output } = await invokeCli(["org/spark", "--trigger", "/incubate custom"]);

    expect(result.ok).toBe(true);
    expect(sendTextCalls).toEqual([]);
    expect(output).toContain("could not resolve spark after wake");
    expect(output).toContain("try manually: maw send-text spark '/incubate custom'");
  });
});
