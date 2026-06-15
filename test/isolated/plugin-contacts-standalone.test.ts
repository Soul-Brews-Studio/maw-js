import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });
const resetConfig = () => {};

const ROOT = new URL("../..", import.meta.url).pathname;

const sdkMock = {
  loadConfig: () => ({}),
  parseFlags: (args: string[], spec: Record<string, unknown>, skip = 0) => {
    const out: Record<string, any> = { _: [] };
    const tokens = args.slice(skip);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.startsWith("--")) {
        out[token] = spec[token] === String ? tokens[++i] : true;
      } else out._.push(token);
    }
    return out;
  },
};
mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));


function walkSources(dir: string): string[] {
  const out: string[] = [];
  const root = existsSync(join(dir, "index.ts")) ? join(dir, "index.ts") : null;
  if (root) out.push(root);
  const impl = existsSync(join(dir, "impl.ts")) ? join(dir, "impl.ts") : null;
  if (impl) out.push(impl);
  return out;
}

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^\"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [importFrom, importFn, requireFn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specs.add(m[1]);
    }
  }

  return [...specs];
}

async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "maw-contacts-isolated-"));
  const cwd = process.cwd();
  const env = { ...process.env };

  process.env.MAW_TEST_MODE = "1";
  process.env.MAW_HOME = home;
  process.chdir(home);
  resetConfig();

  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    process.env.MAW_TEST_MODE = env.MAW_TEST_MODE;
    process.env.MAW_HOME = env.MAW_HOME;
    resetConfig();
    rmSync(home, { recursive: true, force: true });
  }
}

const allowList = new Set(["maw-js/sdk"]);

describe("contacts plugin standalone coverage", () => {
  test("plugin has no core imports", () => {
    const pluginDir = join(ROOT, "src/vendor/mpr-plugins/contacts");
    const files = walkSources(pluginDir);
    const disallowed = files
      .flatMap((p) => parseImportSpecs(Bun.file(p).text()))
      .filter((spec) => spec.startsWith("maw-js/") && !allowList.has(spec));

    expect(disallowed).toEqual([]);
  });

  test("plugin loads from manifest and --help works", async () => {
    const pluginDir = join(ROOT, "src/vendor/mpr-plugins/contacts");
    const loaded = loadManifestFromDir(pluginDir);
    expect(loaded).not.toBeNull();
    const plugin = loaded as LoadedPlugin;

    const result = await invokePlugin(plugin, {
      source: "cli",
      args: ["--help"],
      writer: (...args: unknown[]) => {
        void args;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output || "").toMatch(/contacts/i);
  });

  test("cli and api paths execute with sandboxed state", async () => {
    await withSandbox(async () => {
      const pluginDir = join(ROOT, "src/vendor/mpr-plugins/contacts");
      const loaded = loadManifestFromDir(pluginDir);
      expect(loaded).not.toBeNull();
      const plugin = loaded as LoadedPlugin;

      const cliOut: string[] = [];
      const cli = await invokePlugin(plugin, {
        source: "cli",
        args: [],
        writer: (...args: unknown[]) => cliOut.push(args.map(String).join(" ")),
      });
      expect(cli.ok).toBe(true);
      expect(cliOut.join("\n")).toContain("no contacts");

      const api = await invokePlugin(plugin, {
        source: "api",
        args: {},
      });
      expect(api.ok).toBe(true);
      expect(api.output || "").toContain("no contacts");
    });
  });
});
