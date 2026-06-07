import { describe, expect, test } from "bun:test";
import { FLEET_DIR } from "../src/core/paths";
import { mawStatePath } from "../src/core/xdg";
import { fleetDirForWrite, fleetDirsForRead, fleetDirsFromOverrides, uniqueDirs } from "../src/core/fleet/paths";

describe("fleet path helpers", () => {
  test("dedupes while preserving precedence", () => {
    expect(uniqueDirs(["/state", "", "/legacy", "/state"])).toEqual(["/state", "/legacy"]);
  });

  test("reads state fleet before legacy config fleet and writes to state", () => {
    expect(fleetDirsForRead()).toEqual(uniqueDirs([mawStatePath("fleet"), FLEET_DIR]));
    expect(fleetDirForWrite()).toBe(mawStatePath("fleet"));
  });

  test("single-dir and multi-dir overrides keep existing injection seams", () => {
    expect(fleetDirsFromOverrides("/only")).toEqual(["/only"]);
    expect(fleetDirsFromOverrides("/ignored", ["/state", "/legacy", "/state"])).toEqual(["/state", "/legacy"]);
  });
});
