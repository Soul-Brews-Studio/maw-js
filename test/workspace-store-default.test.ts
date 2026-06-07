import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalEnv = {
  MAW_HOME: process.env.MAW_HOME,
  MAW_CONFIG_DIR: process.env.MAW_CONFIG_DIR,
  MAW_DATA_DIR: process.env.MAW_DATA_DIR,
};

function restoreEnv(): void {
  if (originalEnv.MAW_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalEnv.MAW_HOME;
  if (originalEnv.MAW_CONFIG_DIR === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalEnv.MAW_CONFIG_DIR;
  if (originalEnv.MAW_DATA_DIR === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = originalEnv.MAW_DATA_DIR;
}

afterEach(() => {
  restoreEnv();
});

describe("workspace-store XDG data paths", () => {
  test("writes joined workspaces to data storage and reads legacy config fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-workspace-store-default-"));
    try {
      const store = await import("../src/commands/shared/workspace-store.ts?workspace-store-default");

      process.env.MAW_HOME = join(root, "instance");
      process.env.MAW_CONFIG_DIR = join(root, "ignored-config");
      expect(store.workspacesDir()).toBe(join(root, "instance", "workspaces"));
      expect(store.configPath("ws-home")).toBe(join(root, "instance", "workspaces", "ws-home.json"));

      delete process.env.MAW_HOME;
      process.env.MAW_DATA_DIR = join(root, "data");
      process.env.MAW_CONFIG_DIR = join(root, "config");
      expect(store.workspacesDir()).toBe(join(root, "data", "workspaces"));

      store.saveWorkspace({
        id: "ws-data",
        name: "Data Workspace",
        hubUrl: "https://hub.example",
        sharedAgents: ["mawjs"],
        joinedAt: "2026-05-20T16:15:00.000Z",
      });

      const path = join(root, "data", "workspaces", "ws-data.json");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf-8")).name).toBe("Data Workspace");
      expect(store.loadWorkspace("ws-data")?.sharedAgents).toEqual(["mawjs"]);

      const legacyDir = join(root, "config", "workspaces");
      const { mkdirSync, writeFileSync } = await import("fs");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "ws-legacy.json"), JSON.stringify({
        id: "ws-legacy",
        name: "Legacy Workspace",
        hubUrl: "https://legacy.example",
        sharedAgents: ["legacy"],
        joinedAt: "2026-05-20T16:20:00.000Z",
      }), "utf-8");

      expect(store.loadWorkspace("ws-legacy")?.name).toBe("Legacy Workspace");
      expect(store.loadAllWorkspaces().map(ws => ws.id).sort()).toEqual(["ws-data", "ws-legacy"]);

      writeFileSync(join(root, "data", "workspaces", "ws-created.json"), JSON.stringify({
        id: "ws-created",
        createdAt: "2026-05-20T16:25:00.000Z",
        sharedAgents: ["kept", 42, "also-kept"],
        lastStatus: "bogus",
      }), "utf-8");
      expect(store.loadWorkspace("ws-created")).toEqual({
        id: "ws-created",
        name: "(unnamed)",
        hubUrl: "",
        joinCode: undefined,
        sharedAgents: ["kept", "also-kept"],
        joinedAt: "2026-05-20T16:25:00.000Z",
        lastStatus: undefined,
      });

      writeFileSync(join(root, "data", "workspaces", "ws-corrupt.json"), "{ bad", "utf-8");
      expect(store.loadWorkspace("ws-corrupt")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
