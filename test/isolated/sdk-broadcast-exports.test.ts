import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");

describe("sdk broadcast extraction exports (#2156)", () => {
  test("runtime SDK exposes broadcast helpers", async () => {
    const sdk = await import("../../src/sdk/index");
    expect(typeof sdk.isAgentCommand).toBe("function");
    expect(typeof sdk.loadOracleRegistry).toBe("function");
    expect(typeof sdk.loadFleetEntries).toBe("function");
    expect(typeof sdk.loadFleetCore).toBe("function");
  });

  test("public package SDK and declarations include broadcast helpers", () => {
    const source = readFileSync(join(root, "packages/sdk/index.ts"), "utf8");
    const dts = readFileSync(join(root, "packages/sdk/index.d.ts"), "utf8");
    expect(source).toContain("../../src/core/agent-detect");
    expect(source).toContain("../../src/lib/oracle-members");
    expect(source).toContain("../../src/core/fleet/fleet-load-core");
    expect(dts).toContain("isAgentCommand");
    expect(dts).toContain("loadOracleRegistry");
    expect(dts).toContain("loadFleetEntries");
  });

  test("broadcast plugin imports helpers from SDK boundary", () => {
    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/broadcast/impl.ts"), "utf8");
    expect(impl).toContain('from "maw-js/sdk"');
    expect(impl).not.toContain("../../../core/agent-detect");
    expect(impl).not.toContain("../../../lib/oracle-members");
    expect(impl).not.toContain("../../../commands/shared/fleet-load");
  });
});
