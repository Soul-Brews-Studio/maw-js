/** Isolated coverage for src/commands/plugins/plugin/init-impl.ts. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { cmdPluginInit } = await import("../../src/commands/plugins/plugin/init-impl.ts?plugin-init-impl-coverage");

const originalCwd = process.cwd();
const originalLog = console.log;

let sandbox = "";
let logs: string[] = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "maw-plugin-init-impl-"));
  logs = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  process.chdir(sandbox);
});

afterEach(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("cmdPluginInit", () => {
  test("validates required name, name shape, --ts flag, and existing destinations", async () => {
    await expect(cmdPluginInit([])).rejects.toThrow("usage: maw plugin init <name> --ts");
    await expect(cmdPluginInit(["--help", "--ts"])).rejects.toThrow("usage: maw plugin init <name> --ts");
    await expect(cmdPluginInit(["Bad_Name", "--ts"])).rejects.toThrow(
      'invalid name "Bad_Name" — use lowercase letters, digits, hyphens (must start with a letter)',
    );
    await expect(cmdPluginInit(["demo-plugin"])).rejects.toThrow(
      "usage: maw plugin init <name> --ts  (only --ts is supported in Phase A)",
    );

    mkdirSync(join(sandbox, "demo-plugin"));
    await expect(cmdPluginInit(["demo-plugin", "--ts"])).rejects.toThrow(
      `${join(sandbox, "demo-plugin")} already exists`,
    );
    expect(logs).toEqual([]);
  });

  test("scaffolds the TypeScript plugin manifest, source, package, tsconfig, README, and next-step logs", async () => {
    await cmdPluginInit(["demo-plugin", "--ts"]);

    const dest = join(sandbox, "demo-plugin");
    expect(existsSync(join(dest, "src"))).toBe(true);

    expect(readJson(join(dest, "plugin.json"))).toEqual({
      name: "demo-plugin",
      version: "0.1.0",
      sdk: "^1.0.0",
      target: "js",
      entry: "./src/index.ts",
      artifact: { path: "dist/index.js", sha256: null },
      capabilities: [],
      description: "demo-plugin — a maw-js plugin",
      cli: { command: "demo-plugin", help: "Invoke demo-plugin" },
    });

    const source = readFileSync(join(dest, "src", "index.ts"), "utf8");
    expect(source).toContain('import { maw } from "@maw-js/sdk";');
    expect(source).toContain("hello from ${id.node}!");

    const pkg = readJson(join(dest, "package.json"));
    expect(pkg).toEqual({
      name: "demo-plugin",
      version: "0.1.0",
      type: "module",
      main: "src/index.ts",
      scripts: { build: "maw plugin build" },
      devDependencies: {
        "@maw-js/sdk": expect.stringMatching(/^file:.+packages\/sdk$/),
        typescript: "^5.0.0",
      },
    });

    expect(readJson(join(dest, "tsconfig.json"))).toEqual({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["bun"],
        noEmit: true,
      },
      include: ["src/**/*"],
    });

    const readme = readFileSync(join(dest, "README.md"), "utf8");
    expect(readme).toContain("# demo-plugin");
    expect(readme).toContain("maw plugin build");
    expect(readme).toContain("maw demo-plugin");

    expect(logs).toEqual([
      "\u001b[36m⚡\u001b[0m scaffolded \u001b[1mdemo-plugin\u001b[0m (ts)",
      "  next: cd demo-plugin && bun install && maw plugin build",
    ]);
  });
});
