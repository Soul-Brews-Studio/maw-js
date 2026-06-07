/** Extra isolated coverage for src/vendor/mpr-plugins/health/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type CheckConfig = {
  port: number;
  peers?: string[];
  namedPeers?: Array<{ name: string; url: string }>;
};

type FetchResult = { ok: boolean; status: number; json?: () => Promise<unknown> };
type CurlResult = { ok: boolean; status: number };

let config: CheckConfig = { port: 4321 };
let tmuxSessions: unknown[] = [];
let tmuxShouldThrow = false;
let fetchResult: FetchResult | Error = { ok: true, status: 200, json: async () => ({ sessions: 2 }) };
let curlResults = new Map<string, CurlResult | Error>();
let execHandler: (cmd: string) => string = () => "";
let execCalls: string[] = [];
let curlCalls: Array<{ url: string; timeout: number }> = [];
let logs: string[] = [];

const originalLog = console.log;
const originalFetch = globalThis.fetch;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function output() {
  return logs.join("\n");
}

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
  cfgTimeout: (name: string) => (name === "health" ? 1234 : 1),
}));

mock.module("maw-js/sdk", () => ({
  tmux: {
    listSessions: mock(async () => {
      if (tmuxShouldThrow) throw new Error("tmux down");
      return tmuxSessions;
    }),
  },
  curlFetch: mock(async (url: string, options: { timeout: number }) => {
    curlCalls.push({ url, timeout: options.timeout });
    const result = curlResults.get(url);
    if (result instanceof Error) throw result;
    if (!result) throw new Error(`unexpected curlFetch: ${url}`);
    return result;
  }),
}));

mock.module("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    return execHandler(cmd);
  },
}));

const { cmdHealth } = await import("../../src/vendor/mpr-plugins/health/impl.ts?health-impl-second-pass-coverage");

beforeEach(() => {
  config = { port: 4321 };
  tmuxSessions = [{ name: "one" }, { name: "two" }];
  tmuxShouldThrow = false;
  fetchResult = { ok: true, status: 200, json: async () => ({ sessions: 2 }) };
  curlResults = new Map();
  execCalls = [];
  curlCalls = [];
  logs = [];
  execHandler = (cmd: string) => {
    if (cmd === "df -h /tmp | tail -1") return "/dev/disk 100G 20G 80G 20% /tmp";
    if (cmd === "free -m | grep Mem") return "Mem: 16000 1000 2000 0 0 12000";
    if (cmd === "pm2 jlist 2>/dev/null") {
      return JSON.stringify([{ name: "maw", pid: 4242, pm2_env: { status: "online" } }]);
    }
    throw new Error(`unexpected execSync: ${cmd}`);
  };
  setPlatform("linux");
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  globalThis.fetch = (mock(async () => {
    if (fetchResult instanceof Error) throw fetchResult;
    return fetchResult;
  }) as unknown) as typeof fetch;
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("health impl second-pass coverage", () => {
  test("reports healthy local checks, uses probe POST timeout, and reconciles raw plus named peers", async () => {
    config = {
      port: 9876,
      peers: ["http://peer-a"],
      namedPeers: [{ name: "beta", url: "http://peer-b" }],
    };
    curlResults.set("http://peer-a/api/federation/status", { ok: true, status: 200 });
    curlResults.set("http://peer-b/api/federation/status", { ok: false, status: 503 });

    await cmdHealth();

    expect(globalThis.fetch).toHaveBeenCalledWith("http://localhost:9876/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: expect.any(AbortSignal),
    });
    expect(execCalls).toEqual(["df -h /tmp | tail -1", "free -m | grep Mem", "pm2 jlist 2>/dev/null"]);
    expect(curlCalls).toEqual([
      { url: "http://peer-a/api/federation/status", timeout: 1234 },
      { url: "http://peer-b/api/federation/status", timeout: 1234 },
    ]);

    const out = output();
    expect(out).toContain("tmux server        running (2 sessions)");
    expect(out).toContain("maw server         online (:9876, 2 sessions, probe ok)");
    expect(out).toContain("disk /tmp          80G free");
    expect(out).toContain("memory             12000MB available");
    expect(out).toContain("pm2 maw            online (pid 4242)");
    expect(out).toContain("peer http://peer-a online");
    expect(out).toContain("peer beta (http://peer-b) HTTP 503");
  });

  test("covers failure and warning fallbacks for tmux, server, disk, memory, pm2, and peers", async () => {
    tmuxShouldThrow = true;
    fetchResult = { ok: false, status: 418, json: async () => ({}) };
    config = { port: 1111, peers: ["http://offline"] };
    curlResults.set("http://offline/api/federation/status", new Error("offline"));
    execHandler = (cmd: string) => {
      if (cmd === "df -h /tmp | tail -1") return "/dev/disk 100G 95G 4G 97% /tmp";
      if (cmd === "free -m | grep Mem") throw new Error("free missing");
      if (cmd === "pm2 jlist 2>/dev/null") return "not json";
      throw new Error(`unexpected execSync: ${cmd}`);
    };

    await cmdHealth();

    const out = output();
    expect(out).toContain("tmux server        not running");
    expect(out).toContain("maw server         HTTP 418 (probe)");
    expect(out).toContain("disk /tmp          4G free");
    expect(out).toContain("memory             unknown");
    expect(out).toContain("pm2 maw            pm2 not available");
    expect(out).toContain("peer http://offline unreachable");
  });

  test("covers JSON fallback session count, disk unknown, macOS memory parsing, missing pm2 maw, and no peers", async () => {
    fetchResult = { ok: true, status: 200, json: async () => ({ sessions: "unknown" }) };
    setPlatform("darwin");
    execHandler = (cmd: string) => {
      if (cmd === "df -h /tmp | tail -1") throw new Error("df unavailable");
      if (cmd === "vm_stat") return "Pages free: 10.\nPages inactive: 22.";
      if (cmd === "sysctl -n hw.pagesize") return "4096\n";
      if (cmd === "pm2 jlist 2>/dev/null") return JSON.stringify([{ name: "other", pid: 9, pm2_env: { status: "online" } }]);
      throw new Error(`unexpected execSync: ${cmd}`);
    };

    await cmdHealth();

    const out = output();
    expect(out).toContain("maw server         online (:4321, ? sessions, probe ok)");
    expect(out).toContain("disk /tmp          unknown");
    expect(out).toContain("memory             0MB available");
    expect(out).toContain("pm2 maw            not found");
    expect(out).toContain("peers              none configured");
  });

  test("covers offline server and pm2 non-online maw status", async () => {
    fetchResult = new Error("server down");
    execHandler = (cmd: string) => {
      if (cmd === "df -h /tmp | tail -1") return "/dev/disk 100G 30G 70G 30% /tmp";
      if (cmd === "free -m | grep Mem") return "Mem: 16000 1000 2000 0 0 400";
      if (cmd === "pm2 jlist 2>/dev/null") return JSON.stringify([{ name: "maw", pid: 77, pm2_env: { status: "stopped" } }]);
      throw new Error(`unexpected execSync: ${cmd}`);
    };

    await cmdHealth();

    const out = output();
    expect(out).toContain("maw server         offline");
    expect(out).toContain("memory             400MB available");
    expect(out).toContain("pm2 maw            stopped (pid 77)");
    expect(out).toContain("peers              none configured");
  });

  test("covers probe json parse fallback for ok server responses", async () => {
    fetchResult = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
    };

    await cmdHealth();

    expect(output()).toContain("maw server         online (:4321, ? sessions, probe ok)");
  });
});
