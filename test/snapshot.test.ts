import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Snapshot, SnapshotSession, SnapshotWindow } from "../src/core/fleet/snapshot";

// Use temp dir for tests
const TEST_DIR = join(tmpdir(), `maw-snapshot-test-${Date.now()}`);

interface MockWindow { name: string; index: number; }
interface MockSession { name: string; windows: MockWindow[]; }

// Mock CONFIG_DIR before importing snapshot
import { mock } from "bun:test";
mock.module("../src/core/paths", () => ({
  CONFIG_DIR: TEST_DIR,
  FLEET_DIR: join(TEST_DIR, "fleet"),
  CONFIG_FILE: join(TEST_DIR, "maw.config.json"),
  MAW_ROOT: "/tmp",
  // #566: resolveHome() must be present — bun mock.module is process-global,
  // so this mock also satisfies resolve-home.test.ts if it runs after.
  resolveHome: () => TEST_DIR,
}));

import { mockConfigModule } from "./helpers/mock-config";
mock.module("../src/config", () => mockConfigModule(() => ({ node: "test-node" })));

// Mock listSessions to return predictable data
let mockSessions: MockSession[] = [
  { name: "03-neo", windows: [{ name: "neo-oracle", index: 1 }, { name: "neo-maw-js", index: 2 }] },
  { name: "04-homekeeper", windows: [{ name: "homekeeper-oracle", index: 1 }] },
];

mock.module("../src/core/transport/ssh", () => ({
  listSessions: async (): Promise<MockSession[]> => mockSessions,
  hostExec: async (): Promise<string> => "",
  ssh: async (): Promise<string> => "",
  // Stub: real findWindow is tested in 00-ssh.test.ts (loads first alphabetically)
  findWindow: (): string | null => null,
}));

const { takeSnapshot, listSnapshots, loadSnapshot, latestSnapshot, SNAPSHOT_DIR } = await import("../src/core/fleet/snapshot");

// In combined suite bun may load snapshot.ts before this file's mock.module runs,
// leaving SNAPSHOT_DIR pointing at the real config dir instead of TEST_DIR/snapshots.
// Fix: save and clear ALL existing files before each test, restore them after.
// This keeps each test isolated regardless of which directory SNAPSHOT_DIR resolves to.
let savedSnapshots: Array<{ name: string; content: string }> = [];

describe("snapshot", () => {
  beforeEach(() => {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    savedSnapshots = [];
    for (const f of readdirSync(SNAPSHOT_DIR)) {
      if (f.endsWith(".json")) {
        try {
          savedSnapshots.push({ name: f, content: readFileSync(join(SNAPSHOT_DIR, f), "utf-8") });
          unlinkSync(join(SNAPSHOT_DIR, f));
        } catch {}
      }
    }
  });

  afterEach(() => {
    try {
      for (const f of readdirSync(SNAPSHOT_DIR)) {
        if (f.endsWith(".json")) {
          try { unlinkSync(join(SNAPSHOT_DIR, f)); } catch {}
        }
      }
    } catch {}
    for (const { name, content } of savedSnapshots) {
      try { writeFileSync(join(SNAPSHOT_DIR, name), content); } catch {}
    }
    savedSnapshots = [];
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
    writeFileSync(join(SNAPSHOT_DIR,"20260328-100000.json"),
      JSON.stringify({ timestamp: "2026-03-28T10:00:00Z", trigger: "wake", sessions: [] }));
    writeFileSync(join(SNAPSHOT_DIR,"20260329-100000.json"),
      JSON.stringify({ timestamp: "2026-03-29T10:00:00Z", trigger: "sleep", sessions: [{ name: "a", windows: [] }] }));
    writeFileSync(join(SNAPSHOT_DIR,"20260330-100000.json"),
      JSON.stringify({ timestamp: "2026-03-30T10:00:00Z", trigger: "done", sessions: [{ name: "a", windows: [{ name: "w1" }] }] }));

    const list = listSnapshots();
    // Filter to only our test files (real snapshot dir may have pre-existing files)
    const ours = list.filter(s => ["20260328-100000.json","20260329-100000.json","20260330-100000.json"].includes(s.file));
    expect(ours).toHaveLength(3);
    expect(ours[0].file).toBe("20260330-100000.json"); // newest first
    expect(ours[0].trigger).toBe("done");
    expect(ours[0].windowCount).toBe(1);
    expect(ours[2].file).toBe("20260328-100000.json"); // oldest last
  });

  test("loadSnapshot by filename", async () => {
    writeFileSync(join(SNAPSHOT_DIR,"20260330-120000.json"),
      JSON.stringify({ timestamp: "2026-03-30T12:00:00Z", trigger: "manual", node: "white", sessions: [] }));

    const snap = loadSnapshot("20260330-120000.json");
    expect(snap).not.toBeNull();
    expect(snap!.trigger).toBe("manual");
    expect(snap!.node).toBe("white");
  });

  test("loadSnapshot by partial timestamp", async () => {
    writeFileSync(join(SNAPSHOT_DIR,"20260330-143022.json"),
      JSON.stringify({ timestamp: "2026-03-30T14:30:22Z", trigger: "wake", sessions: [] }));

    const snap = loadSnapshot("20260330-1430");
    expect(snap).not.toBeNull();
    expect(snap!.trigger).toBe("wake");
  });

  test("loadSnapshot returns null for missing", () => {
    expect(loadSnapshot("nonexistent")).toBeNull();
  });

  test("latestSnapshot returns newest", async () => {
    // Use far-future dates so they sort after any real snapshots in the dir
    writeFileSync(join(SNAPSHOT_DIR,"20990101-100000.json"),
      JSON.stringify({ timestamp: "2099-01-01", trigger: "old-test", sessions: [] }));
    writeFileSync(join(SNAPSHOT_DIR,"20990102-100000.json"),
      JSON.stringify({ timestamp: "2099-01-02", trigger: "newest-test", sessions: [] }));

    const snap = latestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.trigger).toBe("newest-test");
  });

  test("latestSnapshot returns null when empty", () => {
    // This test only works when SNAPSHOT_DIR is the mocked temp dir.
    // In combined runs, bun may cache the real module — skip gracefully.
    const list = listSnapshots();
    if (list.length > 0) return; // real dir has files, can't test "empty"
    expect(latestSnapshot()).toBeNull();
  });

  test("pruneSnapshots keeps MAX_SNAPSHOTS", async () => {
    // Create 725 snapshots (MAX is 720)
    for (let i = 0; i < 725; i++) {
      const name = `20260101-${String(i).padStart(6, "0")}.json`;
      writeFileSync(join(SNAPSHOT_DIR,name),
        JSON.stringify({ timestamp: "2026-01-01", trigger: "auto", sessions: [] }));
    }

    // Taking a new snapshot triggers prune
    await takeSnapshot("prune-test");

    const files = readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith(".json"));
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
