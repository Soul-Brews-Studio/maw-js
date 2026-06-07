/** Targeted isolated coverage for src/vendor/mpr-plugins/bud/smart-default-org.ts. */
import { describe, expect, test } from "bun:test";
import {
  fetchGhDefaultLogin,
  formatOrgSource,
  resolveOrg,
  smartDefaultOrgFromFleet,
  type OrgResolution,
} from "../../src/vendor/mpr-plugins/bud/smart-default-org";

const fleet = (rows: any[]) => () => rows;

describe("bud smart default org coverage", () => {
  test("smartDefaultOrgFromFleet ignores invalid rows and picks most recent budded_at", () => {
    const pick = smartDefaultOrgFromFleet(fleet([
      { name: "01-empty", windows: [] },
      { name: "02-bad", windows: [{ repo: "missing-slash", name: "bad-oracle" }] },
      { name: "03-old", budded_at: "2026-01-01T00:00:00.000Z", windows: [{ repo: "OldOrg/old-oracle", name: "old-oracle" }] },
      { name: "04-new", budded_at: "2026-05-18T01:02:03.000Z", windows: [{ repo: "NewOrg/new-oracle", name: "new-oracle" }] },
    ]));

    expect(pick).toEqual({ org: "NewOrg", oracle: "new-oracle", date: "2026-05-18" });
  });

  test("smartDefaultOrgFromFleet tie-breaks by numeric fleet prefix and falls back to session name", () => {
    expect(smartDefaultOrgFromFleet(fleet([]))).toBeNull();
    expect(smartDefaultOrgFromFleet(fleet([{ name: "no-repo", windows: [{ name: "x" }] }]))).toBeNull();

    const pick = smartDefaultOrgFromFleet(fleet([
      { name: "07-alpha", windows: [{ repo: "AlphaOrg/alpha-oracle" }] },
      { name: "12-beta", windows: [{ repo: "BetaOrg/beta-oracle" }] },
    ]));

    expect(pick).toEqual({ org: "BetaOrg", oracle: "12-beta", date: "" });
  });

  test("fetchGhDefaultLogin trims output and fails closed", async () => {
    await expect(fetchGhDefaultLogin(async () => " nat\n")).resolves.toBe("nat");
    await expect(fetchGhDefaultLogin(async () => "\n")).resolves.toBeNull();
    await expect(fetchGhDefaultLogin(async () => { throw new Error("offline"); })).resolves.toBeNull();
  });

  test("resolveOrg follows flag/env/config/fleet/gh/default precedence", async () => {
    const deps = {
      loadFleetFn: fleet([{ name: "99-fleet", budded_at: "2026-05-18T00:00:00.000Z", windows: [{ repo: "FleetOrg/fleet-oracle", name: "fleet-oracle" }] }]),
      execFn: async () => "gh-user\n",
    };

    await expect(resolveOrg({ flag: "FlagOrg", env: "EnvOrg", config: "ConfigOrg" }, deps)).resolves.toEqual({ org: "FlagOrg", source: "flag" });
    await expect(resolveOrg({ env: "EnvOrg", config: "ConfigOrg" }, deps)).resolves.toEqual({ org: "EnvOrg", source: "env" });
    await expect(resolveOrg({ config: "ConfigOrg" }, deps)).resolves.toEqual({ org: "ConfigOrg", source: "config" });
    await expect(resolveOrg({}, deps)).resolves.toEqual({ org: "FleetOrg", source: "fleet", detail: "most recent: fleet-oracle, 2026-05-18" });
    await expect(resolveOrg({}, { loadFleetFn: fleet([]), execFn: async () => "gh-user\n" })).resolves.toEqual({ org: "gh-user", source: "gh", detail: "cold start — no fleet entries" });
    await expect(resolveOrg({}, { loadFleetFn: fleet([]), execFn: async () => "" })).resolves.toEqual({ org: "Soul-Brews-Studio", source: "default" });
  });

  test("formatOrgSource renders every source with optional details", () => {
    const cases: Array<[OrgResolution, string]> = [
      [{ org: "x", source: "flag" }, "--org flag"],
      [{ org: "x", source: "env" }, "MAW_BUD_OWNER env"],
      [{ org: "x", source: "config" }, "config.githubOrg"],
      [{ org: "x", source: "fleet", detail: "most recent: a" }, "fleet (most recent: a)"],
      [{ org: "x", source: "gh", detail: "cold start" }, "gh user (cold start)"],
      [{ org: "x", source: "default" }, "hardcoded default (Soul-Brews-Studio)"],
    ];

    for (const [input, expected] of cases) expect(formatOrgSource(input)).toBe(expected);
  });
});
