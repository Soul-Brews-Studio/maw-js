import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalMawHome = process.env.MAW_HOME;
const originalMawConfigDir = process.env.MAW_CONFIG_DIR;
const originalMawDataDir = process.env.MAW_DATA_DIR;
const root = mkdtempSync(join(tmpdir(), "maw-workspace-storage-next-"));

process.env.MAW_HOME = root;
delete process.env.MAW_CONFIG_DIR;
delete process.env.MAW_DATA_DIR;

const storage = await import("../../src/api/workspace-storage.ts");

beforeEach(() => {
  storage.workspaces.clear();
  rmSync(storage.WORKSPACE_DIR, { recursive: true, force: true });
  rmSync(join(root, "config", "workspaces"), { recursive: true, force: true });
});

afterAll(() => {
  storage.workspaces.clear();
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (originalMawConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalMawConfigDir;
  if (originalMawDataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = originalMawDataDir;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function workspace(id: string, joinCode: string, expiresAt: number) {
  return {
    id,
    name: id,
    token: `${id}-token`,
    joinCode,
    joinCodeExpiresAt: expiresAt,
    createdAt: new Date(0).toISOString(),
    creatorNodeId: "creator",
    nodes: [],
    agents: [],
    feed: [],
  };
}

describe("workspace storage next coverage", () => {
  test("stores hub workspace data under XDG data with legacy config fallback", () => {
    expect(storage.WORKSPACE_DIR).toBe(join(root, "workspaces"));

    const legacyDir = join(root, "config", "workspaces");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "legacy.json"),
      JSON.stringify(workspace("legacy", "legacy-code", Date.now() + 60_000)),
      "utf-8",
    );

    storage.loadAll();
    expect(storage.workspaces.get("legacy")?.joinCode).toBe("legacy-code");

    const fresh = workspace("fresh", "fresh-code", Date.now() + 60_000);
    storage.persist(fresh as any);

    expect(existsSync(join(root, "workspaces", "fresh.json"))).toBe(true);
    expect(existsSync(join(legacyDir, "fresh.json"))).toBe(false);
  });

  test("loadAll creates the workspace directory, loads JSON files, and ignores corrupt/non-json files", () => {
    mkdirSync(storage.WORKSPACE_DIR, { recursive: true });
    writeFileSync(join(storage.WORKSPACE_DIR, "notes.txt"), "not a workspace", "utf-8");
    writeFileSync(join(storage.WORKSPACE_DIR, "bad.json"), "{ bad", "utf-8");
    writeFileSync(
      join(storage.WORKSPACE_DIR, "alpha.json"),
      JSON.stringify(workspace("alpha", "join-alpha", Date.now() + 60_000)),
      "utf-8",
    );

    storage.loadAll();

    expect(storage.workspaces.size).toBe(1);
    expect(storage.workspaces.get("alpha")?.joinCode).toBe("join-alpha");
    expect(existsSync(storage.WORKSPACE_DIR)).toBe(true);
  });

  test("loadAll returns early when the in-memory cache is already populated", () => {
    storage.workspaces.set("cached", workspace("cached", "cached-code", Date.now() + 60_000) as any);

    storage.loadAll();

    expect(storage.workspaces.size).toBe(1);
    expect(storage.workspaces.get("cached")?.joinCode).toBe("cached-code");
  });

  test("persist writes pretty JSON and findByJoinCode filters expired or missing codes", () => {
    const fresh = workspace("fresh", "join-me", Date.now() + 60_000);
    const expired = workspace("expired", "old-code", Date.now() - 1);
    storage.workspaces.set(fresh.id, fresh as any);
    storage.workspaces.set(expired.id, expired as any);

    storage.persist(fresh as any);

    const persisted = readFileSync(join(storage.WORKSPACE_DIR, "fresh.json"), "utf-8");
    expect(persisted).toContain('\n  "id": "fresh"');
    expect(persisted.endsWith("\n")).toBe(true);
    expect(storage.findByJoinCode("join-me")?.id).toBe("fresh");
    expect(storage.findByJoinCode("old-code")).toBeUndefined();
    expect(storage.findByJoinCode("missing")).toBeUndefined();
  });

  test("isCacheStale only reports an empty in-memory cache", () => {
    expect(storage.isCacheStale()).toBe(true);
    storage.workspaces.set("non-empty", workspace("non-empty", "code", Date.now() + 1_000) as any);
    expect(storage.isCacheStale()).toBe(false);
  });
});
