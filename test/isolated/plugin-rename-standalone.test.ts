import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;

interface SpawnResult {
  exitCode?: number | null;
  status?: number | null;
  stdout?: string | Uint8Array | null;
  stderr?: string | Uint8Array | null;
}

const originalSpawnSync = Bun.spawnSync;
let calls: string[][] = [];

function mockSpawnSync(cmd: string[], _opts: Record<string, unknown>): SpawnResult {
  calls.push(cmd);

  const [program, ...args] = cmd;
  if (program !== "tmux") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (args[0] === "display-message" && args.includes("#S")) {
    return { exitCode: 0, stdout: "03-neo\n", stderr: "" };
  }

  if (args[0] === "list-windows") {
    return { exitCode: 0, stdout: "0:alpha\n1:beta\n", stderr: "" };
  }

  if (args[0] === "rename-window") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  return { exitCode: 0, stdout: "", stderr: "" };
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
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

beforeEach(() => {
  calls = [];
  (Bun as any).spawnSync = mockSpawnSync;
});

afterEach(() => {
  (Bun as any).spawnSync = originalSpawnSync;
});

describe("rename plugin standalone coverage", () => {
  test("plugin has no core imports beyond SDK runtime", () => {
    const pluginDir = join(ROOT, "src/vendor/mpr-plugins/rename");
    const files = walkSources(join(pluginDir, "src"));
    const imports = files.flatMap((p) => parseImportSpecs(readFileSync(p, "utf8")));

    const disallowed = imports.filter((spec) => {
      if (spec.startsWith(".")) return false;
      return spec !== "@maw-js/sdk/plugin";
    });

    expect(disallowed).toEqual([]);
  });

  test("plugin loads and CLI --help returns InvokeResult", async () => {
    const pluginDir = join(ROOT, "src/vendor/mpr-plugins/rename");
    const loaded = loadManifestFromDir(pluginDir);
    expect(loaded).not.toBeNull();
    const plugin = loaded as LoadedPlugin;

    const result = await invokePlugin(plugin, {
      source: "cli",
      args: ["--help"],
      writer: (...args: unknown[]) => {},
    });
    expect(result.ok).toBe(true);
    expect(result.output || "").toMatch(/maw rename/i);
  });

  test("plugin CLI rename path returns InvokeResult and invokes tmux with expected args", async () => {
    const pluginDir = join(ROOT, "src/vendor/mpr-plugins/rename");
    const loaded = loadManifestFromDir(pluginDir);
    expect(loaded).not.toBeNull();
    const plugin = loaded as LoadedPlugin;
    const out: string[] = [];

    const result = await invokePlugin(plugin, {
      source: "cli",
      args: ["1", "work"],
      writer: (...args: unknown[]) => {
        out.push(args.map(String).join(" "));
      },
    });

    expect(result.ok).toBe(true);
    expect(out.join("\n")).toContain("neo-work");
    expect(calls).toEqual([
      ["tmux", "display-message", "-p", "#S"],
      ["tmux", "list-windows", "-t", "03-neo", "-F", "#I:#W"],
      ["tmux", "rename-window", "-t", "03-neo:1", "neo-work"],
    ]);
  });
});
