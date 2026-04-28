/**
 * Tests for workspace-storage from src/api/workspace-storage.ts.
 * Uses mock.module for paths (mkdirSync at import).
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = join(tmpdir(), `maw-test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tmp, { recursive: true });

// Mock paths to use temp dir
mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmp,
  FLEET_DIR: join(tmp, "fleet"),
  CONFIG_FILE: join(tmp, "maw.config.json"),
  MAW_ROOT: tmp,
  resolveHome: () => tmp,
}));

const ws = await import("../../src/api/workspace-storage");

describe("workspace-storage", () => {
  beforeEach(() => {
    ws.workspaces.clear();
    // Clean workspace dir to prevent cross-test pollution
    try {
      for (const f of readdirSync(ws.WORKSPACE_DIR)) {
        rmSync(join(ws.WORKSPACE_DIR, f), { force: true });
      }
    } catch {}
  });

  it("WORKSPACE_DIR is under CONFIG_DIR", () => {
    expect(ws.WORKSPACE_DIR).toContain(tmp);
  });

  it("isCacheStale returns true when empty", () => {
    expect(ws.isCacheStale()).toBe(true);
  });

  it("isCacheStale returns false after adding entry", () => {
    ws.workspaces.set("ws-1", { id: "ws-1" } as any);
    expect(ws.isCacheStale()).toBe(false);
  });

  it("findByJoinCode returns undefined for unknown code", () => {
    expect(ws.findByJoinCode("UNKNOWN")).toBeUndefined();
  });

  it("findByJoinCode returns workspace with valid code", () => {
    const workspace = {
      id: "ws-1",
      joinCode: "ABC123",
      joinCodeExpiresAt: Date.now() + 60000,
    };
    ws.workspaces.set("ws-1", workspace as any);
    expect(ws.findByJoinCode("ABC123")).toBeDefined();
    expect(ws.findByJoinCode("ABC123")!.id).toBe("ws-1");
  });

  it("findByJoinCode returns undefined for expired code", () => {
    const workspace = {
      id: "ws-1",
      joinCode: "ABC123",
      joinCodeExpiresAt: Date.now() - 1000, // expired
    };
    ws.workspaces.set("ws-1", workspace as any);
    expect(ws.findByJoinCode("ABC123")).toBeUndefined();
  });

  it("persist writes JSON file", () => {
    const workspace = { id: "test-ws", name: "Test" };
    ws.persist(workspace as any);
    const filePath = join(ws.WORKSPACE_DIR, "test-ws.json");
    expect(existsSync(filePath)).toBe(true);
  });

  it("loadAll loads persisted workspaces", () => {
    // Write a workspace file
    const dir = ws.WORKSPACE_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ws-load.json"), JSON.stringify({ id: "ws-load", name: "Load Test" }));
    ws.workspaces.clear();
    ws.loadAll();
    expect(ws.workspaces.has("ws-load")).toBe(true);
  });

  it("loadAll skips corrupt JSON", () => {
    const dir = ws.WORKSPACE_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "not json");
    ws.workspaces.clear();
    ws.loadAll(); // should not throw
  });

  it("loadAll skips non-json files", () => {
    const dir = ws.WORKSPACE_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "readme.txt"), "not a workspace");
    writeFileSync(join(dir, "valid.json"), JSON.stringify({ id: "valid", name: "V" }));
    ws.workspaces.clear();
    ws.loadAll();
    expect(ws.workspaces.has("valid")).toBe(true);
    expect(ws.workspaces.size).toBe(1);
  });

  it("loadAll does not reload when cache is populated", () => {
    ws.workspaces.set("existing", { id: "existing", name: "In Memory" } as any);
    const dir = ws.WORKSPACE_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "disk.json"), JSON.stringify({ id: "disk", name: "On Disk" }));
    ws.loadAll();
    expect(ws.workspaces.has("disk")).toBe(false);
    expect(ws.workspaces.has("existing")).toBe(true);
  });

  it("loadAll loads multiple workspaces", () => {
    const dir = ws.WORKSPACE_DIR;
    mkdirSync(dir, { recursive: true });
    for (const id of ["a", "b", "c"]) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, name: id.toUpperCase() }));
    }
    ws.workspaces.clear();
    ws.loadAll();
    expect(ws.workspaces.size).toBe(3);
  });

  it("findByJoinCode scans all workspaces", () => {
    ws.workspaces.set("ws-a", { id: "ws-a", joinCode: "AAA", joinCodeExpiresAt: Date.now() + 60000 } as any);
    ws.workspaces.set("ws-b", { id: "ws-b", joinCode: "BBB", joinCodeExpiresAt: Date.now() + 60000 } as any);
    ws.workspaces.set("ws-c", { id: "ws-c", joinCode: "CCC", joinCodeExpiresAt: Date.now() + 60000 } as any);
    expect(ws.findByJoinCode("CCC")!.id).toBe("ws-c");
  });

  it("persist writes pretty-printed JSON with trailing newline", () => {
    const workspace = { id: "pretty-ws", name: "Pretty" };
    ws.persist(workspace as any);
    const raw = readFileSync(join(ws.WORKSPACE_DIR, "pretty-ws.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("  "); // indented
  });

  it("persist overwrites existing file", () => {
    const workspace = { id: "overwrite-ws", name: "v1" };
    ws.persist(workspace as any);
    workspace.name = "v2";
    ws.persist(workspace as any);
    const raw = readFileSync(join(ws.WORKSPACE_DIR, "overwrite-ws.json"), "utf-8");
    expect(JSON.parse(raw).name).toBe("v2");
  });
});

// Cleanup
afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

import { afterAll } from "bun:test";
