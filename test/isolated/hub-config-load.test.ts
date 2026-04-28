/**
 * Tests for loadWorkspaceConfigs from src/transports/hub-config.ts.
 * Uses mock.module to redirect CONFIG_DIR → temp dir.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "hub-config-"));
const wsDir = join(tmp, "workspaces");

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const { loadWorkspaceConfigs, WORKSPACES_DIR } = await import(
  "../../src/transports/hub-config"
);

beforeEach(() => {
  try { rmSync(wsDir, { recursive: true, force: true }); } catch {}
});

describe("loadWorkspaceConfigs", () => {
  it("returns empty array when workspaces dir does not exist", () => {
    const configs = loadWorkspaceConfigs();
    expect(configs).toEqual([]);
  });

  it("returns empty array when workspaces dir is empty", () => {
    mkdirSync(wsDir, { recursive: true });
    const configs = loadWorkspaceConfigs();
    expect(configs).toEqual([]);
  });

  it("loads valid workspace config", () => {
    mkdirSync(wsDir, { recursive: true });
    const cfg = {
      id: "team-1",
      hubUrl: "wss://hub.example.com",
      token: "secret-token",
      sharedAgents: ["neo", "pulse"],
    };
    writeFileSync(join(wsDir, "team.json"), JSON.stringify(cfg));

    const configs = loadWorkspaceConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe("team-1");
    expect(configs[0].hubUrl).toBe("wss://hub.example.com");
    expect(configs[0].sharedAgents).toEqual(["neo", "pulse"]);
  });

  it("loads multiple workspace configs", () => {
    mkdirSync(wsDir, { recursive: true });
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(wsDir, `${name}.json`), JSON.stringify({
        id: name,
        hubUrl: `wss://${name}.example.com`,
        token: `token-${name}`,
        sharedAgents: [],
      }));
    }

    const configs = loadWorkspaceConfigs();
    expect(configs).toHaveLength(3);
  });

  it("skips non-json files", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "readme.txt"), "not a config");
    writeFileSync(join(wsDir, "valid.json"), JSON.stringify({
      id: "ok",
      hubUrl: "wss://hub.example.com",
      token: "tok",
      sharedAgents: [],
    }));

    const configs = loadWorkspaceConfigs();
    expect(configs).toHaveLength(1);
  });

  it("skips invalid JSON files", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "corrupt.json"), "not{json");
    const configs = loadWorkspaceConfigs();
    expect(configs).toEqual([]);
  });

  it("skips config missing id", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      hubUrl: "wss://hub.example.com",
      token: "tok",
      sharedAgents: [],
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });

  it("skips config missing hubUrl", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      id: "x",
      token: "tok",
      sharedAgents: [],
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });

  it("skips config missing token", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      id: "x",
      hubUrl: "wss://hub.example.com",
      sharedAgents: [],
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });

  it("skips config with non-array sharedAgents", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      id: "x",
      hubUrl: "wss://hub.example.com",
      token: "tok",
      sharedAgents: "not-array",
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });

  it("rejects http:// hubUrl (requires ws/wss)", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      id: "x",
      hubUrl: "http://hub.example.com",
      token: "tok",
      sharedAgents: [],
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });

  it("accepts ws:// hubUrl", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "ok.json"), JSON.stringify({
      id: "local",
      hubUrl: "ws://192.168.1.100:3456",
      token: "tok",
      sharedAgents: ["neo"],
    }));
    const configs = loadWorkspaceConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].hubUrl).toBe("ws://192.168.1.100:3456");
  });

  it("rejects invalid URL", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      id: "x",
      hubUrl: "not-a-url",
      token: "tok",
      sharedAgents: [],
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });

  it("rejects empty id", () => {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "bad.json"), JSON.stringify({
      id: "",
      hubUrl: "wss://hub.example.com",
      token: "tok",
      sharedAgents: [],
    }));
    expect(loadWorkspaceConfigs()).toEqual([]);
  });
});
