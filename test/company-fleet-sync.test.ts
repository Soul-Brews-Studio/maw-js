import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  syncOracleAssignment,
  clearOracleAssignment,
  readOracleAssignment,
} from "../src/vendor/mpr-plugins/company/company-helpers";

let home = "";
const origHome = process.env.MAW_HOME;

function writeFleetConfig(name: string, extra: Record<string, unknown> = {}) {
  const fleetDir = join(home, "fleet");
  mkdirSync(fleetDir, { recursive: true });
  const file = join(fleetDir, `01-${name}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { name: `01-${name}`, windows: [{ name: `${name}-oracle`, repo: `acme/${name}-oracle` }], sync_peers: [], ...extra },
      null,
      2,
    ) + "\n",
  );
  return file;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maw-company-fleet-"));
  process.env.MAW_HOME = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = origHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("per-oracle fleet config sync", () => {
  test("sync writes company/department/deptRole without disturbing existing fields", () => {
    const file = writeFleetConfig("payment-dev", { budded_from: "payment-lead" });

    const ok = syncOracleAssignment("payment-dev", {
      company: "kob",
      department: "payment",
      deptRole: "dev",
    });
    expect(ok).toBe(true);

    const cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.company).toBe("kob");
    expect(cfg.department).toBe("payment");
    expect(cfg.deptRole).toBe("dev");
    // existing fields preserved
    expect(cfg.budded_from).toBe("payment-lead");
    expect(cfg.windows[0].repo).toBe("acme/payment-dev-oracle");
    expect(cfg.sync_peers).toEqual([]);
  });

  test("readOracleAssignment round-trips the synced fields", () => {
    writeFleetConfig("p1");
    syncOracleAssignment("p1", { company: "kob", department: "frontend", deptRole: "qa" });
    expect(readOracleAssignment("p1")).toEqual({
      company: "kob",
      department: "frontend",
      deptRole: "qa",
    });
  });

  test("clear only removes assignment when company/department still match", () => {
    writeFleetConfig("p1");
    syncOracleAssignment("p1", { company: "kob", department: "payment", deptRole: "dev" });

    // mismatched scope → no-op
    expect(clearOracleAssignment("p1", { company: "kob", department: "frontend" })).toBe(false);
    expect(readOracleAssignment("p1").department).toBe("payment");

    // matching scope → cleared
    expect(clearOracleAssignment("p1", { company: "kob", department: "payment" })).toBe(true);
    expect(readOracleAssignment("p1")).toEqual({
      company: undefined,
      department: undefined,
      deptRole: undefined,
    });
  });

  test("sync is a no-op when the oracle has no fleet config", () => {
    expect(syncOracleAssignment("ghost", { company: "kob", department: "payment" })).toBe(false);
    expect(readOracleAssignment("ghost")).toEqual({});
  });
});
