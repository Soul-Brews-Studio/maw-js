import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = await import("fs");
const realPaths = await import("../../src/core/paths");

const MOCK_CONFIG_FILE = "/tmp/maw-config-second-pass/maw.config.json";

let rawConfigText = "{}";
let readError: Error | null = null;
let writeError: Error | null = null;
let readCalls: string[] = [];
let writeCalls: Array<{ path: string; data: string }> = [];

let validatedConfig: Record<string, any> = {};
let validateError: Error | null = null;
let validateCalls = 0;

let loadFleetResult: Record<string, string> = {};
let loadFleetError: Error | null = null;
let loadFleetCalls: Array<{ agents: Record<string, string>; node: string | undefined }> = [];

let verboseEnabled = true;
let infoMessages: string[] = [];
let refreshCalls = 0;

let stderrWrites: string[] = [];
let oldStderrWrite: typeof process.stderr.write;

await mock.module("fs", () => ({
  ...realFs,
  readFileSync: ((path: string | Buffer | URL, ...args: unknown[]) => {
    const pathText = String(path);
    if (pathText === MOCK_CONFIG_FILE) {
      readCalls.push(pathText);
      if (readError) throw readError;
      return rawConfigText;
    }
    return (realFs.readFileSync as any)(path, ...args);
  }) as typeof realFs.readFileSync,
  writeFileSync: ((path: string | Buffer | URL, data: string | ArrayBufferView, ...args: unknown[]) => {
    const pathText = String(path);
    if (pathText === MOCK_CONFIG_FILE) {
      writeCalls.push({ path: pathText, data: String(data) });
      if (writeError) throw writeError;
      return;
    }
    return (realFs.writeFileSync as any)(path, data, ...args);
  }) as typeof realFs.writeFileSync,
}));

await mock.module(import.meta.resolve("../../src/core/paths"), () => ({
  ...realPaths,
  CONFIG_FILE: MOCK_CONFIG_FILE,
}));

await mock.module(import.meta.resolve("../../src/lib/context"), () => ({
  refreshContext: () => {
    refreshCalls += 1;
  },
}));

await mock.module(import.meta.resolve("../../src/cli/verbosity"), () => ({
  verbose: (fn: () => void) => {
    if (verboseEnabled) fn();
  },
  info: (message: string) => {
    infoMessages.push(message);
  },
}));

await mock.module(import.meta.resolve("../../src/config/validate-ext"), () => ({
  validateConfig: (_raw: unknown) => {
    validateCalls += 1;
    if (validateError) throw validateError;
    return validatedConfig;
  },
}));

await mock.module(import.meta.resolve("../../src/config/fleet-merge"), () => ({
  loadFleetAgents: (agents: Record<string, string>, node?: string) => {
    loadFleetCalls.push({ agents: { ...agents }, node });
    if (loadFleetError) throw loadFleetError;
    return { ...loadFleetResult };
  },
}));

const config = await import("../../src/config/load.ts?config-load-second-pass");

beforeEach(() => {
  rawConfigText = "{}";
  readError = null;
  writeError = null;
  readCalls = [];
  writeCalls = [];
  validatedConfig = {};
  validateError = null;
  validateCalls = 0;
  loadFleetResult = {};
  loadFleetError = null;
  loadFleetCalls = [];
  verboseEnabled = true;
  infoMessages = [];
  refreshCalls = 0;
  stderrWrites = [];
  oldStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  config.resetConfig();
});

afterEach(() => {
  process.stderr.write = oldStderrWrite;
  config.resetConfig();
});

describe("config load second pass coverage", () => {
  test("caches reads, merges fleet agents with config.node, logs summary, and reset re-arms ghq warning", () => {
    rawConfigText = JSON.stringify({ unused: true });
    validatedConfig = {
      node: "m5",
      ghqRoot: "/legacy/ghq",
      agents: { "manual-oracle": "white" },
      triggers: [{ id: "t1" }],
      pluginSources: [{ name: "plugins-a" }],
      peers: [{ name: "peer-a" }],
      namedPeers: [{ name: "peer-b", url: "http://peer-b" }],
    };
    loadFleetResult = {
      "manual-oracle": "white",
      "fleet-oracle": "m5",
    };

    const first = config.loadConfig();
    const second = config.loadConfig();

    expect(first).toBe(second);
    expect(first.agents).toEqual(loadFleetResult);
    expect(readCalls).toEqual([MOCK_CONFIG_FILE]);
    expect(loadFleetCalls).toEqual([
      { agents: { "manual-oracle": "white" }, node: "m5" },
    ]);
    expect(infoMessages).toEqual([
      "loaded config: 1 trigger, 1 declared plugin, 2 peers",
    ]);
    expect(stderrWrites.filter((line) => line.includes("config.ghqRoot is deprecated"))).toHaveLength(1);

    config.resetConfig();
    const third = config.loadConfig();

    expect(third).not.toBe(first);
    expect(readCalls).toEqual([MOCK_CONFIG_FILE, MOCK_CONFIG_FILE]);
    expect(loadFleetCalls).toEqual([
      { agents: { "manual-oracle": "white" }, node: "m5" },
      { agents: { "manual-oracle": "white" }, node: "m5" },
    ]);
    expect(infoMessages).toEqual([
      "loaded config: 1 trigger, 1 declared plugin, 2 peers",
      "loaded config: 1 trigger, 1 declared plugin, 2 peers",
    ]);
    expect(stderrWrites.filter((line) => line.includes("config.ghqRoot is deprecated"))).toHaveLength(2);
  });

  test("bind-address migration preserves an existing bind and ignores empty fleet merge results", () => {
    verboseEnabled = false;
    rawConfigText = JSON.stringify({ host: "127.0.0.1" });
    validatedConfig = {
      host: "127.0.0.1",
      bind: "10.10.10.10",
      agents: { "manual-oracle": "white" },
    };
    loadFleetResult = {};

    const first = config.loadConfig();
    const second = config.loadConfig();

    expect(first).toBe(second);
    expect(first.host).toBe("local");
    expect(first.bind).toBe("10.10.10.10");
    expect(first.agents).toEqual({ "manual-oracle": "white" });
    expect(loadFleetCalls).toEqual([
      { agents: { "manual-oracle": "white" }, node: undefined },
    ]);
    expect(stderrWrites.filter((line) => line.includes("is a bind address"))).toHaveLength(1);
    expect(infoMessages).toEqual([]);

    config.resetConfig();
    config.loadConfig();
    expect(stderrWrites.filter((line) => line.includes("is a bind address"))).toHaveLength(2);
  });

  test("host=node heal reports persist failure but still returns the in-memory fix", () => {
    verboseEnabled = false;
    rawConfigText = JSON.stringify({ host: "m5", node: "m5" });
    validatedConfig = { host: "m5", node: "m5" };
    writeError = new Error("disk full");

    const loaded = config.loadConfig();

    expect(loaded.host).toBe("local");
    expect(loaded.node).toBe("m5");
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.path).toBe(MOCK_CONFIG_FILE);
    expect(stderrWrites.some((line) => line.includes("legacy init bug (#906)"))).toBe(true);
    expect(
      stderrWrites.some((line) =>
        line.includes("config.host migration: in-memory heal applied but disk persist failed: disk full"),
      ),
    ).toBe(true);
  });

  test("missing config falls back to defaults and swallows unexpected fleet merge failures", () => {
    verboseEnabled = false;
    readError = new Error("ENOENT");
    loadFleetError = new Error("fleet exploded");

    const loaded = config.loadConfig();

    expect(loaded).toEqual({
      host: "local",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    });
    expect(validateCalls).toBe(0);
    expect(loadFleetCalls).toEqual([{ agents: {}, node: undefined }]);
    expect(stderrWrites).toEqual([]);
    expect(infoMessages).toEqual([]);
    expect(refreshCalls).toBe(0);
  });
});
