/**
 * Tests for HubTransport from src/transports/hub-transport.ts.
 * Mocks config, hub-config, and hub-connection to test class logic.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "hub-transport-"));

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
    node: "test-node",
    federationToken: "tok-123",
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

let workspaceConfigs: any[] = [];

mock.module("../../src/transports/hub-config", () => ({
  loadWorkspaceConfigs: () => workspaceConfigs,
  WORKSPACES_DIR: join(tmp, "workspaces"),
}));

const cleanedConnections: any[] = [];
mock.module("../../src/transports/hub-connection", () => ({
  openWebSocket: () => {},
  cleanupConnection: (conn: any) => { cleanedConnections.push(conn); },
}));

const { HubTransport } = await import("../../src/transports/hub-transport");

beforeEach(() => {
  workspaceConfigs = [];
  cleanedConnections.length = 0;
});

describe("HubTransport", () => {
  it("creates with node ID from config", () => {
    const transport = new HubTransport();
    expect(transport.name).toBe("workspace-hub");
    expect(transport.priority).toBe(30);
    expect(transport.connected).toBe(false);
  });

  it("creates with custom node ID", () => {
    const transport = new HubTransport("custom-node");
    expect(transport.connected).toBe(false);
  });

  it("connect does nothing when no workspace configs", async () => {
    const transport = new HubTransport();
    await transport.connect();
    expect(transport.connected).toBe(false);
  });

  it("disconnect clears connected state", async () => {
    const transport = new HubTransport();
    await transport.disconnect();
    expect(transport.connected).toBe(false);
  });

  it("workspaceStatus returns empty when no connections", () => {
    const transport = new HubTransport();
    expect(transport.workspaceStatus()).toEqual([]);
  });

  it("canReach returns false when not connected", () => {
    const transport = new HubTransport();
    expect(transport.canReach({ oracle: "neo" })).toBe(false);
  });

  it("send returns false when no connections", async () => {
    const transport = new HubTransport();
    const result = await transport.send({ oracle: "neo" }, "hello");
    expect(result).toBe(false);
  });

  it("onMessage registers handler", () => {
    const transport = new HubTransport();
    let received = false;
    transport.onMessage(() => { received = true; });
    // Handler registered but not fired (no messages yet)
    expect(received).toBe(false);
  });

  it("onPresence registers handler", () => {
    const transport = new HubTransport();
    let received = false;
    transport.onPresence(() => { received = true; });
    expect(received).toBe(false);
  });

  it("onFeed registers handler", () => {
    const transport = new HubTransport();
    let received = false;
    transport.onFeed(() => { received = true; });
    expect(received).toBe(false);
  });

  it("publishPresence is safe with no connections", async () => {
    const transport = new HubTransport();
    // Should not throw
    await transport.publishPresence({
      oracle: "neo",
      host: "local",
      status: "ready",
      timestamp: Date.now(),
    });
  });

  it("publishFeed is safe with no connections", async () => {
    const transport = new HubTransport();
    await transport.publishFeed({
      timestamp: new Date().toISOString(),
      oracle: "neo",
      host: "local",
      event: "SubagentStart",
      project: "test",
      sessionId: "",
      message: "test",
      ts: Date.now(),
    });
  });
});
