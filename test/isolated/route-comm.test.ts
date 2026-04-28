/**
 * Tests for routeComm from src/cli/route-comm.ts.
 * Mocks cmdSend to test argument parsing and validation.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "route-comm-"));

const sendCalls: { target: string; msg: string; force: boolean }[] = [];

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

mock.module("../../src/commands/shared/comm", () => ({
  cmdSend: async (target: string, msg: string, force: boolean) => {
    sendCalls.push({ target, msg, force });
  },
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({ ghqRoot: tmp, node: "test", agents: {}, namedPeers: [], peers: [], triggers: [], port: 3456 }),
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

const { routeComm } = await import("../../src/cli/route-comm");

beforeEach(() => {
  sendCalls.length = 0;
});

describe("routeComm", () => {
  it("returns false for non-comm commands", async () => {
    expect(await routeComm("peek", ["peek"])).toBe(false);
    expect(await routeComm("ls", ["ls"])).toBe(false);
  });

  it("routes 'hey' command", async () => {
    await routeComm("hey", ["hey", "neo", "hello", "world"]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].target).toBe("neo");
    expect(sendCalls[0].msg).toBe("hello world");
    expect(sendCalls[0].force).toBe(false);
  });

  it("routes 'send' command", async () => {
    await routeComm("send", ["send", "pulse", "test"]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].target).toBe("pulse");
  });

  it("routes 'tell' command", async () => {
    await routeComm("tell", ["tell", "neo", "hi"]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].target).toBe("neo");
  });

  it("passes --force flag", async () => {
    await routeComm("hey", ["hey", "neo", "msg", "--force"]);
    expect(sendCalls[0].force).toBe(true);
    expect(sendCalls[0].msg).toBe("msg");
  });

  it("throws on missing target", async () => {
    expect(routeComm("hey", ["hey"])).rejects.toThrow("missing target");
  });

  it("throws on missing message (#388.3)", async () => {
    expect(routeComm("hey", ["hey", "neo"])).rejects.toThrow("missing message");
  });

  it("returns true for handled commands", async () => {
    const result = await routeComm("hey", ["hey", "neo", "hello"]);
    expect(result).toBe(true);
  });

  it("joins multi-word messages", async () => {
    await routeComm("hey", ["hey", "neo", "hello", "from", "pulse"]);
    expect(sendCalls[0].msg).toBe("hello from pulse");
  });

  it("strips --force from message", async () => {
    await routeComm("hey", ["hey", "neo", "--force", "do", "this"]);
    expect(sendCalls[0].msg).toBe("do this");
    expect(sendCalls[0].force).toBe(true);
  });
});
