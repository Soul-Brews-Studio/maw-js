import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "../..");

const {
  parseNonInteractive,
} = await import("../../src/vendor/mpr-plugins/init/non-interactive.ts?init-plugin-extra-coverage");

const {
  findPluginRoot,
  findMonorepoPluginRoot,
  printInstallSuccess,
  readManifest,
  shortHash,
} = await import("../../src/vendor/mpr-plugins/init/internal/install-manifest-helpers.ts?init-plugin-extra-coverage");

let cmdInitCalls: any[] = [];
let cmdInitResult: any = { ok: true };
let cmdInitThrow: Error | null = null;
let cmdInitConsoleOutput = false;

mock.module(join(srcRoot, "src/vendor/mpr-plugins/init/impl"), () => ({
  cmdInit: async (opts: any) => {
    cmdInitCalls.push(opts);
    opts.writer?.("cmd-init log");
    if (cmdInitConsoleOutput) {
      console.log("cmd-init console log");
      console.error("cmd-init console error");
    }
    if (cmdInitThrow) throw cmdInitThrow;
    return cmdInitResult;
  },
}));

const { default: initHandler } = await import("../../src/vendor/mpr-plugins/init/index.ts?init-plugin-extra-coverage");

const created: string[] = [];
const originalError = console.error;
const originalLog = console.log;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function tempDir(prefix = "maw-init-plugin-extra-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  cmdInitCalls = [];
  cmdInitResult = { ok: true };
  cmdInitThrow = null;
  cmdInitConsoleOutput = false;
  console.error = originalError;
  console.log = originalLog;
  process.stderr.write = originalStderrWrite as any;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("init non-interactive parser extra coverage", () => {
  test("validates node and ghq-root before assembling options", () => {
    expect(parseNonInteractive(["--non-interactive", "--node", "bad_name"], "/Users/tester", { node: "fallback" })).toEqual({
      ok: false,
      error: expect.stringContaining("Node name must"),
    });

    expect(parseNonInteractive(["--non-interactive", "--ghq-root", "relative"], "/Users/tester", { node: "white" })).toEqual({
      ok: false,
      error: "Path must be absolute (start with / or ~)",
    });
  });

  test("honors ghq-root, peers, federation token, force, backup, and default peer names", () => {
    const stderr: string[] = [];
    process.stderr.write = ((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    }) as any;

    const result = parseNonInteractive([
      "--non-interactive",
      "--node", "white-1",
      "--ghq-root", "~/Code",
      "--token", "oauth-token",
      "--peer", "https://mba.example.test:3456",
      "--peer", "http://clinic.example.test:3456",
      "--peer-name", "mba",
      "--federation-token", "fed-token",
      "--force",
      "--backup",
    ], "/Users/tester", { node: "fallback-node" });

    expect(result).toEqual({
      ok: true,
      opts: {
        node: "white-1",
        ghqRoot: "/Users/tester/Code",
        token: "oauth-token",
        federate: true,
        peers: [
          { name: "mba", url: "https://mba.example.test:3456" },
          { name: "peer-2", url: "http://clinic.example.test:3456" },
        ],
        federationToken: "fed-token",
        force: true,
        backup: true,
      },
    });
    expect(stderr.join("")).toContain("--ghq-root is deprecated");
  });

  test("reports indexed peer URL and name validation errors", () => {
    expect(parseNonInteractive([
      "--non-interactive",
      "--node", "white",
      "--peer", "ftp://bad.example.test",
    ], "/Users/tester", { node: "fallback" })).toEqual({
      ok: false,
      error: "--peer #1: URL must start with http:// or https://",
    });

    expect(parseNonInteractive([
      "--non-interactive",
      "--node", "white",
      "--peer", "https://ok.example.test",
      "--peer-name", "bad_name",
    ], "/Users/tester", { node: "fallback" })).toEqual({
      ok: false,
      error: expect.stringContaining("--peer-name #1: Name must"),
    });
  });
});

describe("init plugin handler extra coverage", () => {
  test("returns help for both CLI help spellings without invoking init", async () => {
    await expect(initHandler({ source: "cli", args: ["--help"] } as any)).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("maw init [--non-interactive"),
    });
    await expect(initHandler({ source: "cli", args: ["-h"] } as any)).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("Interactive 3-question wizard"),
    });
    expect(cmdInitCalls).toEqual([]);
  });

  test("captures CLI output on failure and streams output when ctx.writer is present", async () => {
    cmdInitResult = { ok: false, error: "bad init" };
    const failed = await initHandler({ source: "cli", args: ["--non-interactive"] } as any);
    expect(failed).toEqual({ ok: false, error: "bad init", output: "cmd-init log" });
    expect(cmdInitCalls[0].args).toEqual(["--non-interactive"]);

    const streamed: string[] = [];
    cmdInitResult = { ok: true };
    const ok = await initHandler({ source: "cli", args: ["--non-interactive", "--force"], writer: (msg: string) => streamed.push(msg) } as any);
    expect(ok).toEqual({ ok: true, output: undefined });
    expect(streamed).toEqual(["cmd-init log"]);
    expect(cmdInitCalls.at(-1).args).toEqual(["--non-interactive", "--force"]);
  });

  test("captures console log and error through handler hooks", async () => {
    cmdInitConsoleOutput = true;

    const result = await initHandler({ source: "cli", args: ["--non-interactive"] } as any);

    expect(result).toEqual({
      ok: true,
      output: [
        "cmd-init log",
        "cmd-init console log",
        "cmd-init console error",
      ].join("\n"),
    });
    expect(console.log).toBe(originalLog);
    expect(console.error).toBe(originalError);
  });

  test("translates API body fields into non-interactive CLI args", async () => {
    cmdInitResult = { ok: true };

    await expect(initHandler({
      source: "api",
      args: {
        node: "white",
        ghqRoot: "/ignored-by-index",
        token: "oauth-token",
        federate: true,
        peers: [{ name: "mba", url: "https://mba.example.test" }],
        federationToken: "fed-token",
        force: true,
      },
    } as any)).resolves.toEqual({ ok: true, output: "cmd-init log" });

    expect(cmdInitCalls[0].args).toEqual([
      "--non-interactive",
      "--node", "white",
      "--token", "oauth-token",
      "--federate",
      "--peer", "https://mba.example.test",
      "--peer-name", "mba",
      "--federation-token", "fed-token",
      "--force",
    ]);
  });

  test("handles API failures, unsupported sources, thrown errors, and restores console hooks", async () => {
    cmdInitResult = { ok: false, error: "api failed" };
    await expect(initHandler({ source: "api", args: {} } as any)).resolves.toEqual({
      ok: false,
      error: "api failed",
      output: "cmd-init log",
    });

    await expect(initHandler({ source: "timer", args: [] } as any)).resolves.toEqual({ ok: false, error: "unsupported source" });

    cmdInitThrow = new Error("boom");
    await expect(initHandler({ source: "cli", args: [] } as any)).resolves.toEqual({
      ok: false,
      error: "boom",
      output: "cmd-init log",
    });
    expect(console.log).toBe(originalLog);
    expect(console.error).toBe(originalError);
  });
});

describe("init install manifest helper extra coverage", () => {
  test("findPluginRoot covers root, wrapped, malformed, unreadable, and missing manifests", () => {
    const root = tempDir();
    writeFileSync(join(root, "plugin.json"), "{}");
    expect(findPluginRoot(root)).toBe(root);

    expect(findPluginRoot(join(root, "missing"))).toBeNull();

    const crowded = tempDir();
    mkdirSync(join(crowded, "one"));
    mkdirSync(join(crowded, "two"));
    expect(findPluginRoot(crowded)).toBeNull();

    const plainFile = tempDir();
    writeFileSync(join(plainFile, "child"), "");
    expect(findPluginRoot(plainFile)).toBeNull();

    const dangling = tempDir();
    symlinkSync(join(dangling, "missing-target"), join(dangling, "only"));
    expect(findPluginRoot(dangling)).toBeNull();

    const wrappedRoot = tempDir();
    mkdirSync(join(wrappedRoot, "repo-main"));
    writeFileSync(join(wrappedRoot, "repo-main", "plugin.json"), "{}");
    expect(findPluginRoot(wrappedRoot)).toBe(join(wrappedRoot, "repo-main"));

    const wrappedMissing = tempDir();
    mkdirSync(join(wrappedMissing, "repo-main"));
    expect(findPluginRoot(wrappedMissing)).toBeNull();
  });

  test("findMonorepoPluginRoot covers direct, wrapped, malformed, unreadable, and missing subpaths", () => {
    const directRoot = tempDir();
    mkdirSync(join(directRoot, "plugins", "shape"), { recursive: true });
    writeFileSync(join(directRoot, "plugins", "shape", "plugin.json"), "{}");
    expect(findMonorepoPluginRoot(directRoot, "plugins/shape")).toBe(join(directRoot, "plugins", "shape"));

    expect(findMonorepoPluginRoot(join(directRoot, "missing"), "plugins/shape")).toBeNull();

    const crowded = tempDir();
    mkdirSync(join(crowded, "one"));
    mkdirSync(join(crowded, "two"));
    expect(findMonorepoPluginRoot(crowded, "plugins/shape")).toBeNull();

    const plainFile = tempDir();
    writeFileSync(join(plainFile, "child"), "");
    expect(findMonorepoPluginRoot(plainFile, "plugins/shape")).toBeNull();

    const dangling = tempDir();
    symlinkSync(join(dangling, "missing-target"), join(dangling, "only"));
    expect(findMonorepoPluginRoot(dangling, "plugins/shape")).toBeNull();

    const wrappedRoot = tempDir();
    mkdirSync(join(wrappedRoot, "registry-main", "plugins", "shape"), { recursive: true });
    writeFileSync(join(wrappedRoot, "registry-main", "plugins", "shape", "plugin.json"), "{}");
    expect(findMonorepoPluginRoot(wrappedRoot, "plugins/shape")).toBe(join(wrappedRoot, "registry-main", "plugins", "shape"));

    const wrappedMissing = tempDir();
    mkdirSync(join(wrappedMissing, "registry-main", "plugins", "shape"), { recursive: true });
    expect(findMonorepoPluginRoot(wrappedMissing, "plugins/shape")).toBeNull();
  });

  test("readManifest logs missing/invalid manifests and parses valid manifests", () => {
    const errors: string[] = [];
    console.error = ((msg?: any) => { errors.push(String(msg)); }) as any;

    const missing = tempDir();
    expect(readManifest(missing)).toBeNull();
    expect(errors.at(-1)).toContain("no plugin.json");

    const invalid = tempDir();
    writeFileSync(join(invalid, "plugin.json"), "{");
    expect(readManifest(invalid)).toBeNull();
    expect(errors.at(-1)).toContain("invalid plugin.json: plugin.json: invalid JSON");

    const valid = tempDir();
    writeFileSync(join(valid, "plugin.json"), JSON.stringify({
      name: "shape",
      version: "1.2.3",
      sdk: "*",
      capabilities: ["fs:read"],
      cli: { command: "shape" },
    }));

    expect(readManifest(valid)).toMatchObject({
      name: "shape",
      version: "1.2.3",
      sdk: "*",
      capabilities: ["fs:read"],
      cli: { command: "shape" },
    });
  });

  test("shortHash and printInstallSuccess cover all display variants", () => {
    expect(shortHash("sha256:abcdef1234567890")).toBe("abcdef1");
    expect(shortHash("abcdef1234567890")).toBe("abcdef1");

    const lines: string[] = [];
    console.log = ((msg?: any) => { lines.push(String(msg)); }) as any;

    printInstallSuccess({
      name: "shape",
      version: "1.2.3",
      sdk: "*",
      capabilities: ["fs:read", "fs:write"],
      cli: { command: "shape-run" },
    } as any, "/tmp/shape", "linked (dev)", "(from registry)");
    expect(lines.at(-1)).toContain("shape@1.2.3 installed (from registry)");
    expect(lines.at(-1)).toContain("capabilities: fs:read, fs:write");
    expect(lines.at(-1)).toContain("mode: linked (dev)");
    expect(lines.at(-1)).toContain("try: maw shape-run");

    printInstallSuccess({
      name: "plain",
      version: "2.0.0",
      sdk: "*",
    } as any, "/tmp/plain", { sha256: "sha256:1234567890abcdef" });
    expect(lines.at(-1)).toContain("capabilities: (none)");
    expect(lines.at(-1)).toContain("mode: installed (sha256:1234567…)");
    expect(lines.at(-1)).toContain("try: maw plain");
  });
});
