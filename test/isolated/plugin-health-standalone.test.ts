import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

type HealthConfig = {
  port: number;
  peers?: string[];
  namedPeers?: Array<{ name: string; url: string }>;
};

const root = join(import.meta.dir, "../..");
let config: HealthConfig = { port: 4242 };
let sessions: unknown[] = [];
let tmuxError: Error | null = null;
let fetchResult: { ok: boolean; status: number; json?: () => Promise<unknown> } | Error = {
  ok: true,
  status: 200,
  json: async () => ({ sessions: 1 }),
};
let curlResults = new Map<string, { ok: boolean; status: number } | Error>();
let execCalls: string[] = [];
let curlCalls: Array<{ url: string; method?: string; body?: string; from?: string; timeout?: number }> = [];
let execHandler: (cmd: string) => string = () => "";

const sdkMock = {
  loadConfig: () => config,
  cfgTimeout: (name: string) => name === "health" ? 3210 : 1,
  tmux: {
    listSessions: async () => {
      if (tmuxError) throw tmuxError;
      return sessions;
    },
  },
  curlFetch: async (url: string, opts: { method?: string; body?: string; from?: string; timeout?: number }) => {
    curlCalls.push({ url, ...opts });
    const result = curlResults.get(url);
    if (result instanceof Error) throw result;
    if (!result) throw new Error(`unexpected curlFetch: ${url}`);
    return result;
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    return execHandler(cmd);
  },
}));

const { default: healthHandler, command } = await import("../../src/vendor/mpr-plugins/health/index.ts");

const originalFetch = globalThis.fetch;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  config = { port: 4242 };
  sessions = [{ name: "m5" }, { name: "oracle" }];
  tmuxError = null;
  fetchResult = { ok: true, status: 200, json: async () => ({ sessions: 2 }) };
  curlResults = new Map();
  execCalls = [];
  curlCalls = [];
  execHandler = (cmd: string) => {
    if (cmd === "df -h /tmp | tail -1") return "/dev/disk 100G 25G 75G 25% /tmp";
    if (cmd === "free -m | grep Mem") return "Mem: 16000 1000 2000 0 0 12000";
    if (cmd === "pm2 jlist 2>/dev/null") return JSON.stringify([{ name: "maw", pid: 123, pm2_env: { status: "online" } }]);
    throw new Error(`unexpected execSync: ${cmd}`);
  };
  // Default to linux; individual tests override with their own setPlatform().
  setPlatform("linux");
  globalThis.fetch = mock(async () => {
    if (fetchResult instanceof Error) throw fetchResult;
    return fetchResult as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("health plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const indexSource = readFileSync(join(root, "src/vendor/mpr-plugins/health/index.ts"), "utf8");
    const implSource = readFileSync(join(root, "src/vendor/mpr-plugins/health/impl.ts"), "utf8");
    const combined = `${indexSource}\n${implSource}`;

    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/health/plugin.json"), "utf8"));

    expect(command).toMatchObject({ name: "health" });
    expect(manifest.api).toBeUndefined();
    expect(combined).toContain('from "maw-js/sdk"');
    expectStandalonePluginBoundary({ plugin: "health" });
    expect(combined).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(combined).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib|src)\//);
  });

  test("handler renders healthy local checks and delivery-faithful peer probes", async () => {
    setPlatform("linux");
    config = {
      port: 5151,
      peers: ["http://peer-a"],
      namedPeers: [{ name: "beta", url: "http://peer-b" }],
    };
    curlResults.set("http://peer-a/api/probe", { ok: true, status: 200 });
    curlResults.set("http://peer-b/api/probe", { ok: false, status: 503 });

    const result = await healthHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:5151/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: expect.any(AbortSignal),
    });
    expect(execCalls).toEqual(["df -h /tmp | tail -1", "free -m | grep Mem", "pm2 jlist 2>/dev/null"]);
    expect(curlCalls).toEqual([
      { url: "http://peer-a/api/probe", method: "POST", body: "{}", from: "auto", timeout: 3210 },
      { url: "http://peer-b/api/probe", method: "POST", body: "{}", from: "auto", timeout: 3210 },
    ]);
    expect(result.output).toContain("maw health");
    expect(result.output).toContain("tmux server        running (2 sessions)");
    expect(result.output).toContain("maw server         online (:5151, 2 sessions, probe ok)");
    expect(result.output).toContain("peer http://peer-a online (delivery ok)");
    expect(result.output).toContain("peer beta (http://peer-b) HTTP 503 (probe)");
  });

  test("handler reports warning/failure fallbacks without throwing", async () => {
    setPlatform("linux");
    tmuxError = new Error("tmux down");
    fetchResult = new Error("server down");
    config = { port: 6161, peers: ["http://offline"] };
    curlResults.set("http://offline/api/probe", new Error("offline"));
    execHandler = (cmd: string) => {
      if (cmd === "df -h /tmp | tail -1") return "/dev/disk 100G 95G 4G 97% /tmp";
      if (cmd === "free -m | grep Mem") throw new Error("free missing");
      if (cmd === "pm2 jlist 2>/dev/null") return "not json";
      throw new Error(`unexpected execSync: ${cmd}`);
    };

    const result = await healthHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("tmux server        not running");
    expect(result.output).toContain("maw server         offline");
    expect(result.output).toContain("disk /tmp          4G free");
    expect(result.output).toContain("memory             unknown");
    expect(result.output).toContain("peer http://offline unreachable");
    expect(result.output).not.toContain("pm2 maw");
  });

  test("Windows disk/memory fallback and no-peer path stay standalone", async () => {
    // On native Windows the plugin must not call df/free; it falls back to
    // PowerShell Get-PSDrive / Get-CimInstance via winDiskInfo/winMemInfo.
    setPlatform("win32");
    fetchResult = { ok: true, status: 200, json: async () => ({ sessions: "unknown" }) };
    execHandler = (cmd: string) => {
      if (cmd.includes("Get-PSDrive")) return "C 100G 25G 75G 25% /tmp"; // mocked PSDrive line
      if (cmd.includes("FreePhysicalMemory")) return "12345\n";
      if (cmd === "pm2 jlist 2>/dev/null") return JSON.stringify([{ name: "other", pid: 9, pm2_env: { status: "online" } }]);
      throw new Error(`unexpected execSync: ${cmd}`);
    };

    const result = await healthHandler({ source: "api", args: {} } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw server         online (:4242, ? sessions, probe ok)");
    expect(result.output).toContain("disk               "); // win32 label, not "disk /tmp"
    expect(result.output).toContain("memory             12345MB available");
    expect(result.output).toContain("peers              none configured");
  });
});
