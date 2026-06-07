/**
 * Default-suite coverage for queue-store so pending approval storage counts in
 * `bun run test:coverage` (isolated tests validate the same behavior in CI but
 * are intentionally excluded from LCOV generation).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TTL_MS,
  deletePending,
  isExpired,
  loadPending,
  loadPendingById,
  newPendingId,
  pendingDir,
  pendingPath,
  savePending,
  updatePending,
} from "../src/commands/shared/queue-store";

let testDir: string;
let originalConfigDir: string | undefined;
let originalStateDir: string | undefined;
let originalHome: string | undefined;

function resetEnv(dir: string = testDir) {
  process.env.MAW_STATE_DIR = dir;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_HOME;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-queue-store-default-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalStateDir = process.env.MAW_STATE_DIR;
  originalHome = process.env.MAW_HOME;
  resetEnv();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalStateDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("queue-store default coverage", () => {
  test("resolves pending paths from MAW_STATE_DIR and MAW_HOME precedence", () => {
    expect(pendingDir()).toBe(join(testDir, "pending"));
    expect(pendingPath("abc")).toBe(join(testDir, "pending", "abc.json"));

    const home = join(testDir, "home");
    process.env.MAW_HOME = home;
    process.env.MAW_STATE_DIR = join(testDir, "ignored-state");
    process.env.MAW_CONFIG_DIR = join(testDir, "legacy-config");
    expect(pendingDir()).toBe(join(home, "pending"));
  });

  test("loads legacy config pending files while new writes use state", () => {
    const legacyConfig = join(testDir, "legacy-config");
    process.env.MAW_CONFIG_DIR = legacyConfig;
    const legacyDir = join(legacyConfig, "pending");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "legacy.json"), JSON.stringify({
      id: "legacy",
      sender: "old",
      target: "new",
      message: "still pending",
      sentAt: "2026-05-20T00:00:00.000Z",
      status: "pending",
    }));

    const fresh = savePending({ sender: "state", target: "queue", message: "new pending" });

    expect(pendingPath(fresh.id)).toBe(join(testDir, "pending", `${fresh.id}.json`));
    expect(loadPendingById("legacy")?.message).toBe("still pending");
    expect(loadPending().map((record) => record.id)).toEqual(["legacy", fresh.id]);
  });

  test("newPendingId is filesystem-safe and chronological", () => {
    const id = newPendingId(new Date("2026-05-17T11:22:33.444Z"));
    expect(id).toMatch(/^2026-05-17T11-22-33-444Z-[0-9a-f]{6}$/);
    expect(id).not.toContain(":");
  });

  test("savePending writes a record atomically and loadPending returns oldest first", async () => {
    const first = savePending({ sender: "alpha", target: "beta", message: "hi", query: "m5:beta" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = savePending({ sender: "alpha", target: "gamma", message: "again" });

    expect(first).toMatchObject({ sender: "alpha", target: "beta", message: "hi", query: "m5:beta", status: "pending" });
    const onDisk = JSON.parse(readFileSync(pendingPath(first.id), "utf-8"));
    expect(onDisk.id).toBe(first.id);
    expect(readdirSync(pendingDir()).some((file) => file.endsWith(".tmp"))).toBe(false);

    expect(loadPending().map((record) => record.id)).toEqual([first.id, second.id]);
  });

  test("loadPending handles missing dirs, corrupt files, malformed records, and id fallback sorting", () => {
    expect(loadPending()).toEqual([]);
    mkdirSync(pendingDir(), { recursive: true });
    writeFileSync(join(pendingDir(), "z.json"), JSON.stringify({ id: "z", sender: "s", target: "t", message: "late", sentAt: "", status: "pending" }));
    writeFileSync(join(pendingDir(), "a.json"), JSON.stringify({ id: "a", sender: "s", target: "t", message: "early", sentAt: "", status: "pending" }));
    writeFileSync(join(pendingDir(), "bad.json"), "{not json");
    writeFileSync(join(pendingDir(), "missing-id.json"), JSON.stringify({ sender: "s" }));
    writeFileSync(join(pendingDir(), "note.txt"), "ignored");

    expect(loadPending().map((record) => record.id)).toEqual(["a", "z"]);
  });

  test("loadPending and loadPendingById reap expired entries but preserve fresh or unparseable timestamps", () => {
    const old = savePending({ sender: "a", target: "b", message: "old" });
    const fresh = savePending({ sender: "a", target: "b", message: "fresh" });
    const weird = savePending({ sender: "a", target: "b", message: "weird" });

    const oldRecord = JSON.parse(readFileSync(pendingPath(old.id), "utf-8"));
    oldRecord.sentAt = new Date(Date.now() - TTL_MS - 1000).toISOString();
    writeFileSync(pendingPath(old.id), JSON.stringify(oldRecord));

    const freshRecord = JSON.parse(readFileSync(pendingPath(fresh.id), "utf-8"));
    freshRecord.sentAt = new Date(Date.now() - TTL_MS + 60_000).toISOString();
    writeFileSync(pendingPath(fresh.id), JSON.stringify(freshRecord));

    const weirdRecord = JSON.parse(readFileSync(pendingPath(weird.id), "utf-8"));
    weirdRecord.sentAt = "not-a-date";
    writeFileSync(pendingPath(weird.id), JSON.stringify(weirdRecord));

    expect(loadPendingById(old.id)).toBeNull();
    expect(existsSync(pendingPath(old.id))).toBe(false);
    expect(loadPending().map((record) => record.id).sort()).toEqual([fresh.id, weird.id].sort());
    expect(isExpired(weirdRecord)).toBe(false);
  });

  test("loadPendingById returns null for missing, unreadable-looking, corrupt, and malformed files", () => {
    expect(loadPendingById("missing")).toBeNull();
    mkdirSync(pendingDir(), { recursive: true });
    mkdirSync(pendingPath("directory"), { recursive: true });
    writeFileSync(pendingPath("corrupt"), "{nope");
    writeFileSync(pendingPath("malformed"), JSON.stringify({ id: 42 }));
    expect(loadPendingById("directory")).toBeNull();
    expect(loadPendingById("corrupt")).toBeNull();
    expect(loadPendingById("malformed")).toBeNull();
  });

  test("loadPending returns [] when the pending path exists but is not readable as a directory", () => {
    writeFileSync(pendingDir(), "not a directory");
    expect(loadPending()).toEqual([]);
  });

  test("updatePending preserves id, writes atomically, and rejects unknown ids", () => {
    const record = savePending({ sender: "a", target: "b", message: "m" });
    const updated = updatePending(record.id, { id: "evil", status: "approved", message: "changed" });
    expect(updated).toMatchObject({ id: record.id, status: "approved", message: "changed" });
    expect(loadPendingById(record.id)?.status).toBe("approved");
    expect(readdirSync(pendingDir()).some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(() => updatePending("does-not-exist", { status: "rejected" })).toThrow(/pending message not found/);
  });

  test("deletePending reports missing files and unlink failures", () => {
    expect(deletePending("missing")).toBe(false);
    const record = savePending({ sender: "a", target: "b", message: "m" });
    expect(deletePending(record.id)).toBe(true);
    expect(existsSync(pendingPath(record.id))).toBe(false);

    mkdirSync(pendingPath("directory-id"), { recursive: true });
    expect(deletePending("directory-id")).toBe(false);
  });
});
