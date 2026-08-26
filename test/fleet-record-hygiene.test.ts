import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { classifyFleetDrift, isFleetRecordClean } from "../src/core/fleet/fleet-drift";
import { loadFleet, type FleetSession } from "../src/core/fleet/fleet-load-core";

// Mechanics validated live in the MAW fleet-hygiene lab (2026-08-22): a fleet
// record's windows[] is written once at registration and reconciled by no
// ordinary lifecycle op, so live windows drift freely. These tests encode that
// mechanic and reproduce the three observed drift classes as fixtures.

describe("classifyFleetDrift — mechanic + three drift classes", () => {
  test("ok: record windows exactly match live windows", () => {
    const rec: FleetSession = { name: "s", windows: [{ name: "a" }, { name: "b" }] };
    const r = classifyFleetDrift("s", rec, ["a", "b"]);
    expect(r.drift).toBe("ok");
    expect(r.unrecorded).toEqual([]);
    expect(r.dead).toEqual([]);
    expect(isFleetRecordClean(rec, ["a", "b"])).toBe(true);
  });

  test("class A — no-record: live session with no fleet record (nntn-stock-lead)", () => {
    const r = classifyFleetDrift("nntn-stock-lead", null, ["lead"]);
    expect(r.drift).toBe("no-record");
    expect(r.recordWindows).toEqual([]);
    expect(r.liveWindows).toEqual(["lead"]);
  });

  test("class B — record-missing-live: window added after register (25-cookbook 1→2)", () => {
    // record captured 1 window at registration; a second window opened later.
    const rec: FleetSession = { name: "25-cookbook", windows: [{ name: "cookbook" }] };
    const r = classifyFleetDrift("25-cookbook", rec, ["cookbook", "cookbook-oracle"]);
    expect(r.drift).toBe("record-missing-live");
    expect(r.unrecorded).toEqual(["cookbook-oracle"]);
    expect(r.dead).toEqual([]);
  });

  test("class C — record-has-dead: windows closed after register (05-nntn 4 vs live 2)", () => {
    const rec: FleetSession = {
      schemaVersion: 2,
      name: "05-nntn",
      windows: [{ name: "nntn-oracle" }, { name: "nntn" }, { name: "nntn-codex" }, { name: "cookbook-dev" }],
    };
    const r = classifyFleetDrift("05-nntn", rec, ["nntn", "nntn-codex"]);
    expect(r.drift).toBe("record-has-dead");
    expect(r.dead.sort()).toEqual(["cookbook-dev", "nntn-oracle"]);
    expect(r.unrecorded).toEqual([]);
  });

  test("runtime-backfill partial-prune still leaves dead windows (nntn 5→4, live 2)", () => {
    // The backfill/capture path pruned one window (cookbook) but did NOT reconcile
    // the other now-dead windows, so drift persists — the third drift source.
    const preBackfill: FleetSession = {
      name: "05-nntn",
      windows: [
        { name: "nntn-oracle" }, { name: "nntn" }, { name: "nntn-codex" },
        { name: "cookbook" }, { name: "cookbook-dev" },
      ],
    };
    const postBackfill: FleetSession = {
      schemaVersion: 2,
      name: "05-nntn",
      windows: [{ name: "nntn-oracle" }, { name: "nntn" }, { name: "nntn-codex" }, { name: "cookbook-dev" }],
    };
    const live = ["nntn", "nntn-codex"];
    // backfill removed exactly "cookbook"
    const prunedOut = preBackfill.windows.map((w) => w.name).filter((n) => !postBackfill.windows.some((w) => w.name === n));
    expect(prunedOut).toEqual(["cookbook"]);
    // but the record is still not clean afterwards — partial reconciliation only
    expect(classifyFleetDrift("05-nntn", postBackfill, live).drift).toBe("record-has-dead");
    expect(isFleetRecordClean(postBackfill, live)).toBe(false);
  });
});

describe("loadFleet read mechanics over fixture records (temp dir)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hyg-fleet-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("reads windows[] as registered; count = window array length", () => {
    writeFileSync(join(dir, "25-cookbook.json"), JSON.stringify({ name: "25-cookbook", windows: [{ name: "cookbook" }] }));
    const fleet = loadFleet([dir]);
    const cookbook = fleet.find((s) => s.name === "25-cookbook");
    expect(cookbook?.windows.length).toBe(1);
    expect(cookbook?.windows[0]?.name).toBe("cookbook");
  });

  test("*.disabled records are excluded from the active fleet", () => {
    writeFileSync(join(dir, "09-live.json"), JSON.stringify({ name: "09-live", windows: [{ name: "w" }] }));
    writeFileSync(join(dir, "10-off.json.disabled"), JSON.stringify({ name: "10-off", windows: [{ name: "w" }] }));
    const names = loadFleet([dir]).map((s) => s.name);
    expect(names).toContain("09-live");
    expect(names).not.toContain("10-off");
  });

  test("first-writer-wins by filename across merged dirs", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "hyg-fleet2-"));
    try {
      // same filename in two dirs; first dir in the list wins
      writeFileSync(join(dir, "07-dup.json"), JSON.stringify({ name: "07-dup", windows: [{ name: "from-dir1" }] }));
      writeFileSync(join(dir2, "07-dup.json"), JSON.stringify({ name: "07-dup", windows: [{ name: "from-dir2" }] }));
      const dup = loadFleet([dir, dir2]).find((s) => s.name === "07-dup");
      expect(dup?.windows[0]?.name).toBe("from-dir1");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
