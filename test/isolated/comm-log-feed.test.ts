/**
 * Tests for logMessage and emitFeed from src/commands/shared/comm-log-feed.ts.
 * Mocks config, os, and fs to test log writing and feed emission.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "comm-log-feed-"));

let configNode = "test-node";
let fetchCalls: { url: string; opts: any }[] = [];

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({
    node: configNode,
    ghqRoot: tmp,
    agents: {},
    namedPeers: [],
    peers: [],
    triggers: [],
    port: 3456,
  }),
  saveConfig: () => {},
  buildCommand: () => "",
  buildCommandInDir: () => "",
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

// Override os.homedir to redirect log writing to temp dir
mock.module("os", () => ({
  ...require("os"),
  homedir: () => tmp,
}));

// Intercept global fetch for emitFeed tests
const origFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, opts?: any) => {
  fetchCalls.push({ url: String(url), opts });
  return new Response("ok");
}) as any;

const { logMessage, emitFeed } = await import(
  "../../src/commands/shared/comm-log-feed"
);

beforeEach(() => {
  configNode = "test-node";
  fetchCalls = [];
});

describe("logMessage", () => {
  it("writes JSONL to ~/.oracle/maw-log.jsonl", async () => {
    await logMessage("neo", "pulse", "hello", "direct");
    const logPath = join(tmp, ".oracle", "maw-log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.to).toBe("pulse");
    expect(parsed.msg).toBe("hello");
    expect(parsed.route).toBe("direct");
  });

  it("normalizes from with node prefix", async () => {
    await logMessage("neo", "pulse", "test", "direct");
    const logPath = join(tmp, ".oracle", "maw-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.from).toBe("test-node:neo");
  });

  it("preserves from if already has colon", async () => {
    await logMessage("remote:neo", "pulse", "test", "federation");
    const logPath = join(tmp, ".oracle", "maw-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.from).toBe("remote:neo");
  });

  it("truncates msg to 500 chars", async () => {
    const longMsg = "x".repeat(1000);
    await logMessage("neo", "pulse", longMsg, "direct");
    const logPath = join(tmp, ".oracle", "maw-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.msg.length).toBe(500);
  });

  it("includes timestamp in log entry", async () => {
    const before = new Date().toISOString();
    await logMessage("neo", "pulse", "test", "direct");
    const logPath = join(tmp, ".oracle", "maw-log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.ts).toBeDefined();
    expect(last.ts >= before).toBe(true);
  });
});

describe("emitFeed", () => {
  it("posts to localhost feed endpoint", () => {
    emitFeed("SessionStart", "neo", "test-node", "started", 3456);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://localhost:3456/api/feed");
  });

  it("sends correct payload", () => {
    emitFeed("Notification", "neo", "mynode", "hello", 4000);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.event).toBe("Notification");
    expect(body.oracle).toBe("neo");
    expect(body.host).toBe("mynode");
    expect(body.message).toBe("hello");
    expect(body.ts).toBeDefined();
  });

  it("uses correct port in URL", () => {
    emitFeed("Test", "neo", "node", "msg", 9999);
    expect(fetchCalls[0].url).toBe("http://localhost:9999/api/feed");
  });

  it("sends POST with JSON content type", () => {
    emitFeed("Test", "neo", "node", "msg", 3456);
    expect(fetchCalls[0].opts.method).toBe("POST");
    expect(fetchCalls[0].opts.headers["Content-Type"]).toBe("application/json");
  });
});
