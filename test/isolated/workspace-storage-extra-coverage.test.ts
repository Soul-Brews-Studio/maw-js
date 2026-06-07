import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalMawHome = process.env.MAW_HOME;
let root = "";
let storage: typeof import("../../src/api/workspace-storage");

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "maw-workspace-storage-"));
  process.env.MAW_HOME = root;
  storage = await import(`../../src/api/workspace-storage.ts?workspace-storage-${Date.now()}-${Math.random()}`);
  storage.workspaces.clear();
});

afterEach(() => {
  storage?.workspaces.clear();
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("workspace storage extra coverage", () => {
  test("loadAll creates config workspace dir and skips non-json/corrupt files", () => {
    const dir = storage.WORKSPACE_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skip.txt"), "ignored");
    writeFileSync(join(dir, "bad.json"), "{ not json");
    writeFileSync(join(dir, "good.json"), JSON.stringify({ id: "one", joinCode: "abc", joinCodeExpiresAt: Date.now() + 1000 }));

    storage.loadAll();
    storage.loadAll();

    expect(storage.workspaces.get("one")?.joinCode).toBe("abc");
    expect(storage.workspaces.size).toBe(1);
  });

  test("persist writes pretty json and findByJoinCode honors expiry", () => {
    const fresh = { id: "fresh", joinCode: "code", joinCodeExpiresAt: Date.now() + 10_000 } as any;
    const expired = { id: "expired", joinCode: "old", joinCodeExpiresAt: Date.now() - 1 } as any;
    storage.workspaces.set(fresh.id, fresh);
    storage.workspaces.set(expired.id, expired);

    storage.persist(fresh);

    expect(readFileSync(join(storage.WORKSPACE_DIR, "fresh.json"), "utf8")).toContain('"id": "fresh"');
    expect(storage.findByJoinCode("code")?.id).toBe("fresh");
    expect(storage.findByJoinCode("old")).toBeUndefined();
    expect(storage.findByJoinCode("missing")).toBeUndefined();
  });

  test("isCacheStale reports empty cache only", () => {
    expect(storage.isCacheStale()).toBe(true);
    storage.workspaces.set("x", { id: "x" } as any);
    expect(storage.isCacheStale()).toBe(false);
  });
});
