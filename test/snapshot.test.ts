import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Snapshot, SnapshotSession, SnapshotWindow } from "../src/snapshot";

// Use temp dir for tests
const TEST_DIR = join(tmpdir(), `maw-snapshot-test-${Date.now()}`);

interface MockWindow { name: string; index: number; }
interface MockSession { name: string; windows: MockWindow[]; }

// Mock CONFIG_DIR before importing snapshot
import { mock } from "bun:test";
mock.module("../src/paths", () => ({
  CONFIG_DIR: TEST_DIR,
  FLEET_DIR: join(TEST_DIR, "fleet"),
  CONFIG_FILE: join(TEST_DIR, "maw.config.json"),
  MAW_ROOT: "/tmp",
}));

mock.module("../src/config", () => ({
  loadConfig: () => ({ node: "test-node" }),
}));

// Mock listSessions to return predictable data
let mockSessions: MockSession[] = [
  { name: "03-neo", windows: [{ name: "neo-oracle", index: 1 }, { name: "neo-maw-js", index: 2 }] },
  { name: "04-homekeeper", windows: [{ name: "homekeeper-oracle", index: 1 }] },
];

mock.module("../src/ssh", () => ({
  listSessions: async (): Promise<MockSession[]> => mockSessions,
  hostExec: async (): Promise<string> => "",
  ssh: async (): Promise<string> => "",
  // Stub: real findWindow is tested in 00-ssh.test.ts (loads first alphabetically)
  findWindow: (): string | null => null,
}));

const { takeSnapshot, listSnapshots, loadSnapshot, latestSnapshot, SNAPSHOT_DIR } = await import("../src/snapshot");

describe("snapshot", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "snapshots"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  test("takeSnapshot creates a JSON file", async () => {
    const path = await takeSnapshot("test");
    expect(path).toContain(".json");

    const data: Snapshot = JSON.parse(readFileSync(path, "utf-8"));
    expect(data.trigger).toBe("test");
    expect(data.node).toBe("test-node");
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions[0].name).toBe("03-neo");
    expect(data.sessions[0].windows).toHaveLength(2);
    expect(data.sessions[1].name).toBe("04-homekeeper");
  });

  test("takeSnapshot filename is YYYYMMDD-HHMMSS", async () => {
    const path = await takeSnapshot("wake");
    const filename = path.split("/").pop()!;
    expect(filename).toMatch(/^\d{8}-\d{6}\.json$/);
  });

  test("listSnapshots returns newest first", async () => {
    // Create 3 snapshots with different names
    writeFileSync(join(TEST_DIR, "snapshots", "20260328-100000.json"),
      JSON.stringify({ timestamp: "2026-03-28T10:00:00Z", trigger: "wake", sessions: [] }));
    writeFileSync(join(TEST_DIR, "snapshots", "20260329-100000.json"),
      JSON.stringify({ timestamp: "2026-03-29T10:00:00Z", trigger: "sleep", sessions: [{ name: "a", windows: [] }] }));
    writeFileSync(join(TEST_DIR, "snapshots", "20260330-100000.json"),
      JSON.stringify({ timestamp: "2026-03-30T10:00:00Z", trigger: "done", sessions: [{ name: "a", windows: [{ name: "w1" }] }] }));

    const list = listSnapshots();
    expect(list).toHaveLength(3);
    expect(list[0].file).toBe("20260330-100000.json"); // newest first
    expect(list[0].trigger).toBe("done");
    expect(list[0].windowCount).toBe(1);
    expect(list[2].file).toBe("20260328-100000.json"); // oldest last
  });

  test("loadSnapshot by filename", async () => {
    writeFileSync(join(TEST_DIR, "snapshots", "20260330-120000.json"),
      JSON.stringify({ timestamp: "2026-03-30T12:00:00Z", trigger: "manual", node: "white", sessions: [] }));

    const snap = loadSnapshot("20260330-120000.json");
    expect(snap).not.toBeNull();
    expect(snap!.trigger).toBe("manual");
    expect(snap!.node).toBe("white");
  });

  test("loadSnapshot by partial timestamp", async () => {
    writeFileSync(join(TEST_DIR, "snapshots", "20260330-143022.json"),
      JSON.stringify({ timestamp: "2026-03-30T14:30:22Z", trigger: "wake", sessions: [] }));

    const snap = loadSnapshot("20260330-1430");
    expect(snap).not.toBeNull();
    expect(snap!.trigger).toBe("wake");
  });

  test("loadSnapshot returns null for missing", () => {
    expect(loadSnapshot("nonexistent")).toBeNull();
  });

  test("latestSnapshot returns newest", async () => {
    writeFileSync(join(TEST_DIR, "snapshots", "20260328-100000.json"),
      JSON.stringify({ timestamp: "2026-03-28", trigger: "old", sessions: [] }));
    writeFileSync(join(TEST_DIR, "snapshots", "20260330-100000.json"),
      JSON.stringify({ timestamp: "2026-03-30", trigger: "new", sessions: [] }));

    const snap = latestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.trigger).toBe("new");
  });

  test("latestSnapshot returns null when empty", () => {
    expect(latestSnapshot()).toBeNull();
  });

  test("pruneSnapshots keeps MAX_SNAPSHOTS", async () => {
    // Create 725 snapshots (MAX is 720)
    for (let i = 0; i < 725; i++) {
      const name = `20260101-${String(i).padStart(6, "0")}.json`;
      writeFileSync(join(TEST_DIR, "snapshots", name),
        JSON.stringify({ timestamp: "2026-01-01", trigger: "auto", sessions: [] }));
    }

    // Taking a new snapshot triggers prune
    await takeSnapshot("prune-test");

    const files = readdirSync(join(TEST_DIR, "snapshots")).filter(f => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(720);
  });

  test("snapshot captures window names", async () => {
    mockSessions = [
      { name: "01-pulse", windows: [
        { name: "pulse-oracle", index: 1 },
        { name: "pulse-scheduler", index: 2 },
        { name: "pulse-cli", index: 3 },
      ]},
    ];

    const path = await takeSnapshot("wake");
    const data: Snapshot = JSON.parse(readFileSync(path, "utf-8"));

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].windows).toHaveLength(3);
    expect(data.sessions[0].windows.map((w: SnapshotWindow) => w.name)).toEqual(["pulse-oracle", "pulse-scheduler", "pulse-cli"]);
  });

  test("snapshot trigger types are preserved", async () => {
    for (const trigger of ["wake", "sleep", "done", "manual"]) {
      const path = await takeSnapshot(trigger);
      const data: Snapshot = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.trigger).toBe(trigger);
    }
  });
});
