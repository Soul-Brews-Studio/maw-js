import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { doLs, doInfo } = await import("../src/commands/shared/plugins-ls-info");

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-plugin-ls-info-"));
  cleanupPaths.push(dir);
  return dir;
}

function plugin(name: string, overrides: Record<string, unknown> = {}) {
  const dir = (overrides.dir as string) ?? `/tmp/${name}`;
  const manifest = (overrides.manifest as Record<string, unknown>) ?? {};
  return {
    kind: "ts",
    dir,
    entryPath: join(dir, "index.ts"),
    wasmPath: join(dir, `${name}.wasm`),
    ...overrides,
    manifest: {
      name,
      version: "1.0.0",
      sdk: "^1.0.0",
      tier: "standard",
      entry: "./index.ts",
      cli: { command: name },
      ...manifest,
    },
  } as never;
}

function capture(fn: () => void) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  console.error = (...args: unknown[]) => err.push(args.join(" "));
  console.warn = (...args: unknown[]) => err.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("plugin ls/info default-suite seams", () => {
  test("doLs renders JSON without loading config", () => {
    const p = plugin("json-demo", { manifest: { tier: undefined, weight: 5 } });
    const { out } = capture(() => doLs(true, false, () => [p], () => {
      throw new Error("should not load config for json output");
    }));

    expect(JSON.parse(out)).toEqual([
      expect.objectContaining({ name: "json-demo", tier: "core", surfaces: "cli:json-demo" }),
    ]);
  });

  test("doLs handles no plugins and no active plugins", () => {
    expect(capture(() => doLs(false, false, () => [], () => ({}))).out).toContain("no plugins installed");

    const onlyDisabled = plugin("disabled-demo");
    expect(capture(() => doLs(false, false, () => [onlyDisabled], () => ({ disabledPlugins: ["disabled-demo"] }))).out)
      .toContain("no active plugins. Use --all to see 1 disabled.");
  });

  test("doLs renders a compact summary by default and filters by tier/api", () => {
    const plugins = [
      plugin("core-api", { manifest: { tier: "core", api: { path: "/api/core", methods: ["GET"] } } }),
      plugin("standard-cli", { manifest: { tier: "standard" } }),
      plugin("extra-api", { manifest: { tier: "extra", api: { path: "/api/extra", methods: ["POST"] } } }),
    ];

    const compact = capture(() => doLs(false, false, () => plugins, () => ({}))).out;
    expect(compact).toContain("3 plugins (3 active, 0 disabled)");
    expect(compact).toContain("core: 1 · standard: 1 · extra: 1");
    expect(compact).toContain("cli: 3 · api: 2 · health:");
    expect(compact).not.toContain("core-api");

    const coreApi = capture(() => doLs(false, false, () => plugins, () => ({}), {
      tiers: ["core"],
      apiOnly: true,
    })).out;
    expect(coreApi).toContain("1 plugin (1 active, 0 disabled) matching core+api");
    expect(coreApi).toContain("core: 1 · standard: 0 · extra: 0");

    const missing = capture(() => doLs(false, false, () => plugins, () => ({}), {
      tiers: ["standard"],
      apiOnly: true,
    })).out;
    expect(missing).toContain("no plugins matching standard+api.");
  });

  test("doLs groups, sorts, colors disabled plugins, and prints totals", () => {
    const plugins = [
      plugin("z-extra", { manifest: { tier: "extra" } }),
      plugin("a-core", { manifest: { tier: "core" } }),
      plugin("b-standard", { manifest: { tier: "standard" } }),
      plugin("a-standard", { manifest: { tier: "standard" } }),
    ];

    const showAll = capture(() => doLs(false, true, () => plugins, () => ({ disabledPlugins: ["b-standard"] }), { verbose: true })).out;
    expect(showAll.indexOf("a-standard")).toBeLessThan(showAll.indexOf("b-standard"));
    expect(showAll).toContain("disabled");
    expect(showAll).toContain("4 total (3 active, 1 disabled)");

    const activeOnly = capture(() => doLs(false, false, () => plugins, () => ({ disabledPlugins: ["b-standard"] }), { verbose: true })).out;
    expect(activeOnly).toContain("3 active. 1 disabled");
    expect(activeOnly).not.toContain("b-standard");

    const noDisabled = capture(() => doLs(false, false, () => [plugins[0]], () => ({}), { verbose: true })).out;
    expect(noDisabled).toContain("1 active");
  });

  test("doLs default loader path remains wired for production callers", () => {
    const out = capture(() => doLs(false, false, () => [plugin(`loader-${process.pid}`)])).out;
    expect(out).toContain("1 plugin (1 active, 0 disabled)");
    expect(out).toContain("health:");
  });

  test("doInfo prints explicit surfaces, default TS cli, and TS entry health", () => {
    const dir = tempDir();
    const entryPath = join(dir, "index.ts");
    writeFileSync(entryPath, "export default {}\n", "utf-8");

    const explicit = plugin("explicit", {
      dir,
      entryPath,
      manifest: {
        description: "demo plugin",
        author: "oracle",
        cli: { command: "exp", help: "runs exp" },
        api: { path: "/api/exp", methods: ["GET", "POST"] },
      },
    });
    const implicit = plugin("implicit", {
      dir,
      entryPath,
      manifest: { cli: undefined },
    });

    const explicitOut = capture(() => doInfo("explicit", () => [explicit])).out;
    expect(explicitOut).toContain("desc:    demo plugin");
    expect(explicitOut).toContain("author:  oracle");
    expect(explicitOut).toContain("cli:     exp  — runs exp");
    expect(explicitOut).toContain("api:     /api/exp  [GET, POST]");
    expect(explicitOut).toContain("entry:");
    expect(explicitOut).toContain("✓");

    expect(capture(() => doInfo("implicit", () => [implicit])).out)
      .toContain("cli:     implicit  (default — no explicit cli field)");
  });

  test("doInfo reports missing TS entries, WASM health, inferred tier, and missing plugin errors", () => {
    const dir = tempDir();
    const wasmPath = join(dir, "demo.wasm");
    writeFileSync(wasmPath, "wasm", "utf-8");

    const missingTs = plugin("missing-ts", { dir, entryPath: join(dir, "missing.ts") });
    const wasmOk = plugin("wasm-ok", {
      kind: "wasm",
      dir,
      entryPath: undefined,
      wasmPath,
      manifest: { tier: undefined, weight: 95, wasm: "./demo.wasm" },
    });
    const wasmMissing = plugin("wasm-missing", {
      kind: "wasm",
      dir,
      entryPath: undefined,
      wasmPath: join(dir, "missing.wasm"),
      manifest: { tier: "extra", wasm: "./missing.wasm" },
    });

    const missingTsResult = capture(() => doInfo("missing-ts", () => [missingTs]));
    expect(missingTsResult.out).toContain("✗ missing");
    expect(missingTsResult.err).toContain("entry file missing");

    expect(capture(() => doInfo("wasm-ok", () => [wasmOk])).out).toContain("tier:    extra (inferred from weight)");

    const wasmMissingResult = capture(() => doInfo("wasm-missing", () => [wasmMissing]));
    expect(wasmMissingResult.out).toContain("wasm:");
    expect(wasmMissingResult.err).toContain("wasm file missing");

    const originalExit = process.exit;
    let exitCode: string | number | null | undefined = null;
    process.exit = ((code?: string | number | null) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;
    try {
      const notFound = capture(() => {
        expect(() => doInfo("ghost", () => [])).toThrow("exit");
      });
      expect(notFound.err).toContain("plugin not found: ghost");
      expect(exitCode).toBe(1);
    } finally {
      process.exit = originalExit;
    }
  });
});
