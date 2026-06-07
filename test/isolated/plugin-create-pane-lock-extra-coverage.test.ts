/** Isolated coverage for plugin create, pane plugin, and plugin lock CLI branch gaps. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const root = join(import.meta.dir, "../..");

let rustCalls: Array<{ name: string; dest: string }> = [];
let asCalls: Array<{ name: string; dest: string }> = [];
let rustFailure: Error | null = null;
let asFailure: Error | null = null;
let swapCalls: Array<[string, string]> = [];
let swapFailure: Error | null = null;
let pinCalls: Array<{ name: string; source: string; opts: { version?: string; signers?: string[] } }> = [];
let pinResult: any;
let unpinCalls: string[] = [];
let unpinResult: any;

mock.module(join(root, "src/commands/shared/plugin-create-rust"), () => ({
  scaffoldRust: (name: string, dest: string) => {
    if (rustFailure) throw rustFailure;
    rustCalls.push({ name, dest });
  },
}));

mock.module(join(root, "src/commands/shared/plugin-create-as"), () => ({
  scaffoldAs: (name: string, dest: string) => {
    if (asFailure) throw asFailure;
    asCalls.push({ name, dest });
  },
}));

mock.module(join(root, "src/commands/plugins/tile/impl"), () => ({
  cmdTileSwap: async (a: string, b: string) => {
    if (swapFailure) throw swapFailure;
    swapCalls.push([a, b]);
  },
}));

mock.module(join(root, "src/commands/plugins/plugin/lock"), () => ({
  pinPlugin: (name: string, source: string, opts: { version?: string; signers?: string[] }) => {
    pinCalls.push({ name, source, opts });
    return pinResult;
  },
  unpinPlugin: (name: string) => {
    unpinCalls.push(name);
    return unpinResult;
  },
}));

const { cmdPluginCreate } = await import("../../src/commands/shared/plugin-create-cmd");
const panePlugin = await import("../../src/commands/plugins/pane/index");
const { cmdPluginPin, cmdPluginUnpin } = await import("../../src/commands/plugins/plugin/lock-cli");

type Captured = { exitCode: number | undefined; stdout: string; stderr: string; thrown?: unknown };

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const originalTmux = process.env.TMUX;
const tempDirs: string[] = [];

async function capture(fn: () => unknown | Promise<unknown>): Promise<Captured> {
  const outs: string[] = [];
  const errs: string[] = [];
  let exitCode: number | undefined;
  let thrown: unknown;
  console.log = (...args: unknown[]) => outs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await fn();
  } catch (err: any) {
    if (!String(err?.message ?? "").startsWith("__exit__")) thrown = err;
  } finally {
    (process as any).exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  return { exitCode, stdout: outs.join("\n"), stderr: errs.join("\n"), thrown };
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  rustCalls = [];
  asCalls = [];
  rustFailure = null;
  asFailure = null;
  swapCalls = [];
  swapFailure = null;
  pinCalls = [];
  pinResult = {
    entry: { version: "1.2.3", sha256: "sha256:new", source: "/new.tgz" },
    previous: undefined,
  };
  unpinCalls = [];
  unpinResult = { removed: null };
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

afterEach(() => {
  (process as any).exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("cmdPluginCreate focused branch coverage", () => {
  test("rejects missing type, conflicting type, missing name, invalid name, and existing destination", async () => {
    let got = await capture(() => cmdPluginCreate("demo", {}));
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("Specify either --rust or --as");

    got = await capture(() => cmdPluginCreate("demo", { "--rust": true, "--as": true }));
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("not both");

    got = await capture(() => cmdPluginCreate(undefined, { "--rust": true }));
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("usage: maw plugin create");

    got = await capture(() => cmdPluginCreate("Bad Name", { "--as": true }));
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("Invalid plugin name");

    const existing = tmpDir("maw-plugin-create-existing-");
    got = await capture(() => cmdPluginCreate("demo", { "--rust": true, "--dest": existing }));
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("Destination already exists");
  });

  test("dispatches rust/as scaffolders and reports scaffold failures", async () => {
    const rustDest = join(tmpDir("maw-plugin-create-rust-parent-"), "demo-rust");
    let got = await capture(() => cmdPluginCreate("demo-rust", { "--rust": true, "--dest": rustDest }));
    expect(got.exitCode).toBeUndefined();
    expect(rustCalls).toEqual([{ name: "demo-rust", dest: rustDest }]);
    expect(got.stdout).toContain("Creating Rust plugin");
    expect(got.stdout).toContain("Plugin scaffolded");

    const asDest = join(tmpDir("maw-plugin-create-as-parent-"), "demo-as");
    got = await capture(() => cmdPluginCreate("demo-as", { "--as": true, "--dest": asDest }));
    expect(got.exitCode).toBeUndefined();
    expect(asCalls).toEqual([{ name: "demo-as", dest: asDest }]);
    expect(got.stdout).toContain("Creating AssemblyScript plugin");
    expect(got.stdout).toContain("assembly/index.ts");

    rustFailure = new Error("scaffold exploded");
    got = await capture(() => cmdPluginCreate("bad-rust", { "--rust": true, "--dest": join(tmpDir("maw-plugin-create-fail-"), "bad-rust") }));
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("scaffold exploded");
  });
});

describe("pane plugin handler focused branch coverage", () => {
  test("requires tmux before parsing subcommands", async () => {
    delete process.env.TMUX;
    const writes: string[] = [];

    const result = await panePlugin.default({ source: "cli", args: ["swap", "1", "2"], writer: (...a: unknown[]) => writes.push(a.join(" ")) } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not in tmux");
    expect(writes.join("\n")).toContain("pane requires tmux");
  });

  test("prints help for API callers and CLI help flags", async () => {
    process.env.TMUX = "%1";
    let result = await panePlugin.default({ source: "api", args: ["swap", "ignored", "ignored"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw pane swap");
    expect(swapCalls).toEqual([]);

    result = await panePlugin.default({ source: "cli", args: ["--help"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("pane targets");
  });

  test("handles unknown, missing args, successful swap, and swap errors", async () => {
    process.env.TMUX = "%1";

    let result = await panePlugin.default({ source: "cli", args: ["rotate"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown subcommand: rotate");
    expect(result.output).toContain("unknown pane subcommand: rotate");

    result = await panePlugin.default({ source: "cli", args: ["swap", "top"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("two pane targets required");
    expect(result.output).toContain("usage: maw pane swap");

    result = await panePlugin.default({ source: "cli", args: ["swap", "top", "bottom"] } as any);
    expect(result.ok).toBe(true);
    expect(swapCalls).toEqual([["top", "bottom"]]);

    swapFailure = new Error("tmux swap failed");
    result = await panePlugin.default({ source: "cli", args: ["swap", "%1", "%2"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tmux swap failed");
  });
});

describe("plugin lock CLI focused branch coverage", () => {
  test("pin validates required args, resolves source, forwards flags, and prints new entry", async () => {
    await expect(cmdPluginPin([])).rejects.toThrow("usage: maw plugin pin");

    const got = await capture(() => cmdPluginPin(["demo", "./demo.tgz", "--version", "1.2.3", "--signer", "alice", "--signer", "bob"]));

    expect(got.thrown).toBeUndefined();
    expect(pinCalls).toEqual([{ name: "demo", source: resolve("./demo.tgz"), opts: { version: "1.2.3", signers: ["alice", "bob"] } }]);
    expect(got.stdout).toContain("pinned demo@1.2.3");
    expect(got.stdout).toContain("sha256: sha256:new");
    expect(got.stdout).toContain("source: /new.tgz");
  });

  test("pin reports changed fields for re-pin results", async () => {
    pinResult = {
      entry: { version: "2.0.0", sha256: "sha256:after", source: "/after.tgz" },
      previous: { version: "1.0.0", sha256: "sha256:before", source: "/before.tgz" },
    };

    const got = await capture(() => cmdPluginPin(["demo", "/tmp/after.tgz"]));

    expect(got.thrown).toBeUndefined();
    expect(got.stdout).toContain("re-pinned demo");
    expect(got.stdout).toContain("version: 1.0.0 → 2.0.0");
    expect(got.stdout).toContain("sha256:  sha256:before → sha256:after");
    expect(got.stdout).toContain("source:  /before.tgz → /after.tgz");
  });

  test("unpin validates required name and prints removed or no-op results", async () => {
    await expect(cmdPluginUnpin([])).rejects.toThrow("usage: maw plugin unpin");

    unpinResult = { removed: { version: "1.0.0", sha256: "sha256:old" } };
    let got = await capture(() => cmdPluginUnpin(["demo"]));
    expect(got.thrown).toBeUndefined();
    expect(unpinCalls).toEqual(["demo"]);
    expect(got.stdout).toContain("unpinned demo (was 1.0.0, sha256:old)");

    unpinCalls = [];
    unpinResult = { removed: null };
    got = await capture(() => cmdPluginUnpin(["missing"]));
    expect(got.thrown).toBeUndefined();
    expect(unpinCalls).toEqual(["missing"]);
    expect(got.stdout).toContain("missing: not in plugins.lock");
  });
});
