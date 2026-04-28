/**
 * inbox-queue — pending-message store + TTL tests (#842 Sub-C).
 *
 * Covers:
 *   - savePending/loadPending round-trip
 *   - oldest-first ordering
 *   - 30-day TTL (expired files reaped on read)
 *   - atomic write (no .tmp left behind on success)
 *   - updatePending merges + preserves id
 *   - loadPendingById vs prefix resolution semantics in queue-store
 *
 * Isolation pattern mirrors trust-list.test.ts / scope-acl.test.ts —
 * MAW_CONFIG_DIR is pointed at a per-test temp dir so the on-disk
 * `<CONFIG_DIR>/pending/` resolves cleanly.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-inbox-queue-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = testDir;
  delete process.env.MAW_HOME;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("queue-store — savePending/loadPending round-trip", () => {
  test("savePending writes a single record and loadPending returns it", async () => {
    const { savePending, loadPending } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "alpha", target: "beta", message: "hi" });
    expect(rec.id).toBeTruthy();
    expect(rec.sender).toBe("alpha");
    expect(rec.target).toBe("beta");
    expect(rec.message).toBe("hi");
    expect(rec.status).toBe("pending");
    const list = loadPending();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(rec.id);
  });

  test("loadPending returns [] when pending dir missing", async () => {
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    expect(loadPending()).toEqual([]);
  });

  test("savePending creates the pending directory if missing", async () => {
    const { savePending, pendingDir } = await import("../../src/commands/shared/queue-store");
    expect(existsSync(pendingDir())).toBe(false);
    savePending({ sender: "a", target: "b", message: "m" });
    expect(existsSync(pendingDir())).toBe(true);
  });

  test("savePending stores all fields on disk in JSON", async () => {
    const { savePending, pendingPath } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "a", target: "b", message: "m", query: "node:b" });
    const onDisk = JSON.parse(readFileSync(pendingPath(rec.id), "utf-8"));
    expect(onDisk.sender).toBe("a");
    expect(onDisk.target).toBe("b");
    expect(onDisk.message).toBe("m");
    expect(onDisk.query).toBe("node:b");
    expect(onDisk.status).toBe("pending");
    expect(onDisk.id).toBe(rec.id);
  });

  test("savePending writes atomically (no .tmp left behind)", async () => {
    const { savePending, pendingDir } = await import("../../src/commands/shared/queue-store");
    savePending({ sender: "a", target: "b", message: "m" });
    const files = readdirSync(pendingDir());
    expect(files.some(f => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("queue-store — ordering", () => {
  test("loadPending returns oldest first", async () => {
    const { savePending, loadPending } = await import("../../src/commands/shared/queue-store");
    const r1 = savePending({ sender: "a", target: "b", message: "first" });
    // Force a measurable timestamp gap.
    await new Promise(res => setTimeout(res, 5));
    const r2 = savePending({ sender: "a", target: "c", message: "second" });
    const list = loadPending();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(r1.id);
    expect(list[1].id).toBe(r2.id);
  });
});

describe("queue-store — TTL (30 days)", () => {
  test("file older than TTL_MS is reaped on loadPending", async () => {
    const { savePending, loadPending, pendingPath, TTL_MS } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "a", target: "b", message: "old" });
    // Rewrite sentAt to be older than TTL.
    const path = pendingPath(rec.id);
    const stale = JSON.parse(readFileSync(path, "utf-8"));
    stale.sentAt = new Date(Date.now() - TTL_MS - 1000).toISOString();
    writeFileSync(path, JSON.stringify(stale, null, 2));
    const list = loadPending();
    expect(list).toHaveLength(0);
    expect(existsSync(path)).toBe(false); // reaped
  });

  test("file just under TTL is preserved", async () => {
    const { savePending, loadPending, pendingPath, TTL_MS } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "a", target: "b", message: "fresh" });
    const path = pendingPath(rec.id);
    const fresh = JSON.parse(readFileSync(path, "utf-8"));
    fresh.sentAt = new Date(Date.now() - TTL_MS + 60_000).toISOString();
    writeFileSync(path, JSON.stringify(fresh, null, 2));
    const list = loadPending();
    expect(list).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
  });

  test("loadPendingById returns null for an expired entry and reaps it", async () => {
    const { savePending, loadPendingById, pendingPath, TTL_MS } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "a", target: "b", message: "old" });
    const path = pendingPath(rec.id);
    const stale = JSON.parse(readFileSync(path, "utf-8"));
    stale.sentAt = new Date(Date.now() - TTL_MS - 1000).toISOString();
    writeFileSync(path, JSON.stringify(stale, null, 2));
    expect(loadPendingById(rec.id)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});

describe("queue-store — updatePending", () => {
  test("updatePending flips status and preserves id", async () => {
    const { savePending, updatePending, loadPendingById } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    const updated = updatePending(rec.id, { status: "approved" });
    expect(updated.id).toBe(rec.id);
    expect(updated.status).toBe("approved");
    const reload = loadPendingById(rec.id);
    expect(reload?.status).toBe("approved");
  });

  test("updatePending throws on unknown id", async () => {
    const { updatePending } = await import("../../src/commands/shared/queue-store");
    expect(() => updatePending("does-not-exist", { status: "approved" })).toThrow(/not found/);
  });
});

describe("queue-store — deletePending", () => {
  test("deletePending removes the file and returns true", async () => {
    const { savePending, deletePending, pendingPath } = await import("../../src/commands/shared/queue-store");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    expect(existsSync(pendingPath(rec.id))).toBe(true);
    expect(deletePending(rec.id)).toBe(true);
    expect(existsSync(pendingPath(rec.id))).toBe(false);
  });

  test("deletePending returns false when file is missing", async () => {
    const { deletePending } = await import("../../src/commands/shared/queue-store");
    expect(deletePending("nope")).toBe(false);
  });
});

describe("queue-store — corrupt files", () => {
  test("corrupt JSON file is skipped silently", async () => {
    const { savePending, loadPending, pendingDir } = await import("../../src/commands/shared/queue-store");
    const good = savePending({ sender: "a", target: "b", message: "good" });
    // Write a junk JSON file alongside.
    writeFileSync(join(pendingDir(), "junk.json"), "{not json");
    const list = loadPending();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(good.id);
  });
});
