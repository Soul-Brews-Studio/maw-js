/**
 * plugin-dts-gen.test.ts — Phase B Wave 1C (#340)
 *
 * Tests for opt-in .d.ts generation via `maw plugin build --types`.
 *
 * Strategy:
 *   1. Create a minimal TypeScript plugin in a temp dir.
 *   2. bun build it to dist/index.js (same as runBuild does).
 *   3. Call generatePluginDts() directly (unit tests).
 *   4. Call cmdPluginBuild with --types (integration test via console capture).
 *
 * Tests run per-file in a subprocess (isolated mode) to avoid mock pollution.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { generatePluginDts } from "../../src/commands/plugins/plugin/dts-gen";
import { cmdPluginBuild } from "../../src/commands/plugins/plugin/build-impl";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];

function tmpDir(prefix = "maw-dts-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

/** Capture console.log lines from an async fn. */
async function capture(fn: () => Promise<unknown>): Promise<{
  stdout: string; stderr: string; error?: Error;
}> {
  const orig = { log: console.log, error: console.error };
  const outs: string[] = [];
  const errs: string[] = [];
  console.log = (...a: any[]) => outs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => errs.push(a.map(String).join(" "));
  let error: Error | undefined;
  try { await fn(); } catch (e: any) { error = e instanceof Error ? e : new Error(String(e)); }
  finally { console.log = orig.log; console.error = orig.error; }
  return { stdout: outs.join("\n"), stderr: errs.join("\n"), error };
}

/**
 * Scaffold a minimal TS plugin dir.
 * Returns the dir path with src/index.ts, plugin.json, dist/index.js.
 */
function scaffoldPlugin(opts: {
  name?: string;
  version?: string;
  /** Extra exported TypeScript content appended to src/index.ts */
  extraExports?: string;
} = {}): string {
  const name = opts.name ?? "hello";
  const version = opts.version ?? "0.1.0";
  const dir = tmpDir("maw-plugin-");

  // plugin.json
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify(
      {
        name,
        version,
        sdk: "^1.0.0",
        target: "js",
        entry: "./src/index.ts",
        artifact: { path: "dist/index.js", sha256: null },
        capabilities: [],
      },
      null,
      2,
    ) + "\n",
  );

  // src/index.ts
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    `export interface ${name.charAt(0).toUpperCase() + name.slice(1)}Config {
  greeting: string;
  count?: number;
}

export default async function handler(ctx: { args: string[] }): Promise<{ ok: boolean; output: string }> {
  return { ok: true, output: "hello from ${name}" };
}
` + (opts.extraExports ?? ""),
  );

  // Pre-build dist/index.js so generatePluginDts can be called without a full build
  mkdirSync(join(dir, "dist"), { recursive: true });
  const build = spawnSync(
    "bun",
    ["build", join(dir, "src", "index.ts"), "--outfile", join(dir, "dist", "index.js"), "--target=bun", "--format=esm"],
    { cwd: dir, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`scaffold bun build failed:\n${build.stderr || build.stdout}`);
  }

  return dir;
}

// ─── Unit: generatePluginDts ─────────────────────────────────────────────────

describe("generatePluginDts", () => {
  test("emits dist/<name>.d.ts for a minimal TS plugin", () => {
    const dir = scaffoldPlugin({ name: "hello" });
    const result = generatePluginDts({
      pluginDir: dir,
      distDir: join(dir, "dist"),
      pluginName: "hello",
      entryPath: join(dir, "src", "index.ts"),
    });

    expect(result.dtsPath).toBe(join(dir, "dist", "hello.d.ts"));
    expect(existsSync(result.dtsPath)).toBe(true);

    const content = readFileSync(result.dtsPath, "utf8");
    // Must contain the exported interface
    expect(content).toContain("HelloConfig");
    expect(content).toContain("greeting: string");
    // Must contain the default export signature
    expect(content).toContain("export default function handler");
  });

  test("emitted .d.ts contains exported types from plugin source", () => {
    const dir = scaffoldPlugin({
      name: "typed",
      extraExports: `
export type PluginMode = "read" | "write";
export interface TypedOptions {
  mode: PluginMode;
  timeout: number;
}
`,
    });

    const result = generatePluginDts({
      pluginDir: dir,
      distDir: join(dir, "dist"),
      pluginName: "typed",
      entryPath: join(dir, "src", "index.ts"),
    });

    const content = readFileSync(result.dtsPath, "utf8");
    expect(content).toContain("PluginMode");
    expect(content).toContain('"read" | "write"');
    expect(content).toContain("TypedOptions");
    expect(content).toContain("timeout: number");
  });

  test("throws when entry file does not exist", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "dist"), { recursive: true });

    expect(() =>
      generatePluginDts({
        pluginDir: dir,
        distDir: join(dir, "dist"),
        pluginName: "missing",
        entryPath: join(dir, "src", "index.ts"),
      }),
    ).toThrow("dts-gen: entry not found");
  });

  test("cleans up tsconfig.emit.json even on failure", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "dist"), { recursive: true });
    // entry doesn't exist → throws before tsc runs
    try {
      generatePluginDts({
        pluginDir: dir,
        distDir: join(dir, "dist"),
        pluginName: "noop",
        entryPath: join(dir, "src", "index.ts"),
      });
    } catch { /* expected */ }

    // tsconfig.emit.json must not be left behind
    expect(existsSync(join(dir, "dist", "tsconfig.emit.json"))).toBe(false);
  });
});

// ─── Integration: cmdPluginBuild --types ─────────────────────────────────────

describe("cmdPluginBuild --types flag", () => {
  test("emits .d.ts when --types is passed", async () => {
    const dir = scaffoldPlugin({ name: "greet" });

    const { stdout, error } = await capture(() =>
      cmdPluginBuild(["--types", dir]),
    );

    expect(error).toBeUndefined();
    expect(existsSync(join(dir, "dist", "greet.d.ts"))).toBe(true);

    const content = readFileSync(join(dir, "dist", "greet.d.ts"), "utf8");
    expect(content).toContain("GreetConfig");

    // Summary line includes types mention
    expect(stdout).toContain("types:");
    expect(stdout).toContain("greet.d.ts");
  });

  test("does NOT emit .d.ts when --types is absent", async () => {
    const dir = scaffoldPlugin({ name: "notypes" });

    const { error } = await capture(() => cmdPluginBuild([dir]));

    expect(error).toBeUndefined();
    expect(existsSync(join(dir, "dist", "notypes.d.ts"))).toBe(false);
  });
});
