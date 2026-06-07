import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = await import("fs");
const realPaths = await import("../../src/core/paths");

const MOCK_CONFIG_FILE = "/tmp/maw-config-second-pass-coverage/maw.config.json";

let rawConfigText = "{}";
let readError: Error | null = null;
let writeError: Error | null = null;
let writeCalls: Array<{ path: string; data: string }> = [];

let validatedConfig: Record<string, any> = {};
let validateError: Error | null = null;

let loadFleetResult: Record<string, string> = {};
let stderrWrites: string[] = [];
let infoMessages: string[] = [];
let oldStderrWrite: typeof process.stderr.write;

await mock.module("fs", () => ({
  ...realFs,
  readFileSync: ((path: string | Buffer | URL, ...args: unknown[]) => {
    const pathText = String(path);
    if (pathText === MOCK_CONFIG_FILE) {
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
  refreshContext: () => {},
}));

await mock.module(import.meta.resolve("../../src/cli/verbosity"), () => ({
  verbose: (fn: () => void) => fn(),
  info: (message: string) => {
    infoMessages.push(message);
  },
}));

await mock.module(import.meta.resolve("../../src/config/validate-ext"), () => ({
  validateConfig: () => {
    if (validateError) throw validateError;
    return validatedConfig;
  },
}));

await mock.module(import.meta.resolve("../../src/config/fleet-merge"), () => ({
  loadFleetAgents: () => ({ ...loadFleetResult }),
}));

const config = await import("../../src/config/load.ts");

beforeEach(() => {
  rawConfigText = "{}";
  readError = null;
  writeError = null;
  writeCalls = [];
  validatedConfig = {};
  validateError = null;
  loadFleetResult = {};
  stderrWrites = [];
  infoMessages = [];
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

const staleProfileDisabled = [
  "team", "fleet", "panes", "peers", "pair", "tmux", "kill", "plugin", "doctor", "inbox",
  "split", "shellenv", "completions", "learn", "find", "talk-to", "project", "workon", "cleanup",
  "manual-a", "manual-b", "manual-c", "manual-d", "manual-e",
];

describe("config load second pass coverage", () => {
  test("promotes every stale default-active disabled plugin wave and persists each migration", () => {
    validatedConfig = {
      disabledPlugins: staleProfileDisabled,
      migrations: {},
    };

    const loaded = config.loadConfig();

    expect(loaded.disabledPlugins).toEqual(["manual-a", "manual-b", "manual-c", "manual-d", "manual-e"]);
    expect(loaded.migrations).toEqual({
      defaultActivePlugins1500: true,
      defaultActivePlugins1514: true,
      defaultActivePlugins1523: true,
      defaultActivePlugins1524: true,
      defaultActivePlugins1531: true,
    });
    expect(writeCalls).toHaveLength(5);
    expect(writeCalls.every((call) => call.path === MOCK_CONFIG_FILE)).toBe(true);
    expect(JSON.parse(writeCalls.at(-1)!.data).disabledPlugins).toEqual(loaded.disabledPlugins);
    expect(stderrWrites.join("")).toContain("config.disabledPlugins migration (#1500)");
    expect(stderrWrites.join("")).toContain("config.disabledPlugins migration (#1514)");
    expect(stderrWrites.join("")).toContain("config.disabledPlugins migration (#1523)");
    expect(stderrWrites.join("")).toContain("config.disabledPlugins migration (#1524)");
    expect(stderrWrites.join("")).toContain("config.disabledPlugins migration (#1531)");
  });

  test("preserves large manual disabled lists when too few stale default-active names are present", () => {
    const mostlyManual = ["team", "fleet", "panes", "peers", ...Array.from({ length: 16 }, (_, index) => `manual-${index}`)];
    validatedConfig = { disabledPlugins: mostlyManual, migrations: {} };

    const loaded = config.loadConfig();

    expect(loaded.disabledPlugins).toEqual(mostlyManual);
    expect(loaded.migrations).toEqual({});
    expect(writeCalls).toEqual([]);
    expect(stderrWrites).toEqual([]);
  });

  test("preserves tiny manual disables for later default-active plugin waves", () => {
    validatedConfig = {
      disabledPlugins: ["split", "shellenv", "completions", "learn"],
      migrations: {},
    };

    const loaded = config.loadConfig();

    expect(loaded.disabledPlugins).toEqual(["split", "shellenv", "completions", "learn"]);
    expect(loaded.migrations).toEqual({});
    expect(writeCalls).toEqual([]);
    expect(stderrWrites).toEqual([]);
  });

  test("uses prior migration markers to continue later default-active plugin waves on small lists", () => {
    validatedConfig = {
      disabledPlugins: ["split", "shellenv", "completions", "learn", "manual"],
      migrations: { defaultActivePlugins1500: true },
    };

    const loaded = config.loadConfig();

    expect(loaded.disabledPlugins).toEqual(["manual"]);
    expect(loaded.migrations).toEqual({
      defaultActivePlugins1500: true,
      defaultActivePlugins1514: true,
      defaultActivePlugins1523: true,
      defaultActivePlugins1524: true,
      defaultActivePlugins1531: true,
    });
    expect(writeCalls).toHaveLength(4);
  });

  test("masks display env without a federation token and returns configured helper overrides", () => {
    validatedConfig = {
      env: { EMPTY: "", TINY: "abcd", LONG: "abcdefghijklmnopqrstuvwxyz" },
      intervals: { capture: 12 },
      timeouts: { http: 34 },
      limits: { messageTruncate: 56 },
      host: "remote-host",
    };

    const display = config.configForDisplay();

    expect(display.env).toEqual({});
    expect(display.envMasked).toEqual({
      EMPTY: "",
      TINY: "••••",
      LONG: "abc••••••••••••••••••••",
    });
    expect(display.federationToken).toBeUndefined();
    expect(config.cfg("host")).toBe("remote-host");
    expect(config.cfgInterval("capture")).toBe(12);
    expect(config.cfgTimeout("http")).toBe(34);
    expect(config.cfgLimit("messageTruncate")).toBe(56);
  });


  test("saveConfig merges updates, refreshes cache, and reloads from persisted data", () => {
    rawConfigText = JSON.stringify({ host: "persisted-old", env: { OLD: "1" } });
    validatedConfig = { host: "persisted-old", env: { OLD: "1" } };

    const saved = config.saveConfig({ host: "persisted-new", env: { NEW: "2" } });

    expect(writeCalls).toHaveLength(1);
    const persisted = JSON.parse(writeCalls[0]!.data);
    expect(persisted.host).toBe("persisted-new");
    expect(persisted.env).toEqual({ NEW: "2" });
    expect(saved.host).toBe("persisted-old");
  });

  test("skips already-marked migrations while continuing unmarked later waves", () => {
    validatedConfig = {
      disabledPlugins: ["shellenv", "completions", "learn", "manual"],
      migrations: {
        defaultActivePlugins1500: true,
        defaultActivePlugins1514: true,
      },
    };

    const loaded = config.loadConfig();

    expect(loaded.disabledPlugins).toEqual(["manual"]);
    expect(loaded.migrations).toEqual({
      defaultActivePlugins1500: true,
      defaultActivePlugins1514: true,
      defaultActivePlugins1523: true,
      defaultActivePlugins1524: true,
      defaultActivePlugins1531: true,
    });
    expect(writeCalls).toHaveLength(3);
  });

  test("reports migration persist failures for stale plugin heals", () => {
    validatedConfig = { disabledPlugins: staleProfileDisabled, migrations: {} };
    writeError = new Error("readonly config");

    const loaded = config.loadConfig();

    expect(loaded.disabledPlugins).toEqual(["manual-a", "manual-b", "manual-c", "manual-d", "manual-e"]);
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    expect(stderrWrites.join("")).toContain("in-memory heal applied but disk persist failed: readonly config");
  });


  test("covers fallback, bind, host-node, ghq, verbose summary, and token masking paths", () => {
    readError = new Error("missing");
    loadFleetResult = {};
    let loaded = config.loadConfig();
    expect(loaded.host).toBe("local");

    config.resetConfig();
    readError = null;
    validatedConfig = { host: "::", node: "m5" };
    loaded = config.loadConfig();
    expect(loaded.host).toBe("local");
    expect(loaded.bind).toBe("::");
    expect(stderrWrites.join("")).toContain("is a bind address");

    config.resetConfig();
    validatedConfig = { host: "m5", node: "m5" };
    loaded = config.loadConfig();
    expect(loaded.host).toBe("local");
    expect(writeCalls.at(-1)?.data).toContain('"host": "local"');
    expect(stderrWrites.join("")).toContain("legacy init bug (#906)");

    config.resetConfig();
    validatedConfig = {
      ghqRoot: "/legacy",
      env: { SECRET: "abcdef" },
      federationToken: "abcdefghijklmnop",
      triggers: [{ id: "a" }, { id: "b" }],
      pluginSources: [{ name: "p1" }, { name: "p2" }],
      peers: [{ name: "peer" }],
    };
    const display = config.configForDisplay();
    expect(display.federationToken).toBe("abcd••••••••••••");
    expect(stderrWrites.join("")).toContain("config.ghqRoot is deprecated");
    expect(config.cfgInterval("capture")).toBe(50);
    expect(config.cfgTimeout("http")).toBe(5000);
    expect(config.cfgLimit("messageTruncate")).toBe(100);
    expect(config.cfg("host")).toBe("local");
    expect(infoMessages.some((message) => message.includes("loaded config:"))).toBe(true);
  });

});
