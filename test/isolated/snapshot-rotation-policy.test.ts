import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-snapshot-rotation-"));
const OLD_MAW_HOME = process.env.MAW_HOME;
process.env.MAW_HOME = SANDBOX;
process.env.MAW_TEST_MODE = "1";

const snapshot = await import("../../src/core/fleet/snapshot.ts?snapshot-rotation-policy");
const SNAP_DIR = snapshot.SNAPSHOT_DIR;

function resetSnapshots() {
  rmSync(SNAP_DIR, { recursive: true, force: true });
  mkdirSync(SNAP_DIR, { recursive: true });
  delete process.env.MAW_SNAPSHOT_KEEP_LAST;
  delete process.env.MAW_SNAPSHOT_MAX_AGE_DAYS;
}

function writeSnapshot(file: string, timestamp: string) {
  writeFileSync(join(SNAP_DIR, file), JSON.stringify({ timestamp, trigger: "manual", sessions: [] }, null, 2));
}

function files() {
  return readdirSync(SNAP_DIR).filter(f => f.endsWith(".json")).sort();
}

beforeEach(resetSnapshots);

afterAll(() => {
  if (OLD_MAW_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = OLD_MAW_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("snapshot rotation policy (#2146)", () => {
  test("pruneSnapshots applies --keep-last style retention", () => {
    writeSnapshot("20260101-000000.json", "2026-01-01T00:00:00.000Z");
    writeSnapshot("20260102-000000.json", "2026-01-02T00:00:00.000Z");
    writeSnapshot("20260103-000000.json", "2026-01-03T00:00:00.000Z");

    const summary = snapshot.pruneSnapshots({ keepLast: 2, maxAgeDays: 3650, now: new Date("2026-01-04T00:00:00.000Z") });

    expect(summary).toMatchObject({ removed: 1, wouldRemove: 0, retained: 2, policy: { keepLast: 2, maxAgeDays: 3650 } });
    expect(files()).toEqual(["20260102-000000.json", "20260103-000000.json"]);
  });

  test("pruneSnapshots supports dry-run and max-age without deleting files", () => {
    writeSnapshot("20260101-000000.json", "2026-01-01T00:00:00.000Z");
    writeSnapshot("20260110-000000.json", "2026-01-10T00:00:00.000Z");

    const summary = snapshot.pruneSnapshots({ keepLast: 10, maxAgeDays: 5, dryRun: true, now: new Date("2026-01-20T00:00:00.000Z") });

    expect(summary).toMatchObject({ removed: 0, wouldRemove: 2, retained: 0, policy: { keepLast: 10, maxAgeDays: 5 } });
    expect(files()).toEqual(["20260101-000000.json", "20260110-000000.json"]);
  });

  test("env provides central defaults and explicit flags win", () => {
    process.env.MAW_SNAPSHOT_KEEP_LAST = "5";
    process.env.MAW_SNAPSHOT_MAX_AGE_DAYS = "6";
    expect(snapshot.resolveSnapshotRetentionPolicy()).toEqual({ keepLast: 5, maxAgeDays: 6 });
    expect(snapshot.resolveSnapshotRetentionPolicy({ keepLast: 2, maxAgeDays: 3 })).toEqual({ keepLast: 2, maxAgeDays: 3 });
  });
});
