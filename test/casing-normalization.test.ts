import { describe, test, expect } from "bun:test";
import { checkCasingDuplicates } from "../src/commands/shared/fleet-doctor";
import { extractOracleStem } from "../src/commands/plugins/fleet/fleet-adopt";

describe("checkCasingDuplicates — #1240 doctor check", () => {
  test("flags mixed-case keys in config.agents", () => {
    const agents = { thClaws: "local", thclaws: "local", homekeeper: "local" };
    const out = checkCasingDuplicates(agents, []);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("casing-duplicates");
    expect(out[0].level).toBe("warn");
    expect(out[0].message).toContain("thClaws");
    expect(out[0].message).toContain("thclaws");
    expect(out[0].detail).toMatchObject({ kind: "agents" });
  });

  test("flags mixed-case fleet window names", () => {
    const out = checkCasingDuplicates({}, ["thClaws-oracle", "thclaws-oracle", "homekeeper-oracle"]);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("casing-duplicates");
    expect(out[0].message).toContain("thClaws-oracle");
    expect(out[0].message).toContain("thclaws-oracle");
    expect(out[0].detail).toMatchObject({ kind: "fleet" });
  });

  test("returns empty for all-lowercase entries", () => {
    const agents = { thclaws: "local", homekeeper: "m5", volt: "m5" };
    const windows = ["thclaws-oracle", "homekeeper-oracle"];
    expect(checkCasingDuplicates(agents, windows)).toEqual([]);
  });

  test("returns empty for empty inputs", () => {
    expect(checkCasingDuplicates({}, [])).toEqual([]);
  });

  test("fixable is false (human must resolve)", () => {
    const out = checkCasingDuplicates({ Foo: "local", foo: "local" }, []);
    expect(out[0].fixable).toBe(false);
  });
});

describe("fleet adopt stem normalization — #1240 write-site fix", () => {
  test("extractOracleStem lowercases mixed-case CLAUDE.md title", () => {
    // extractOracleStem already lowercases — verify the contract holds
    // (nameOverride path is covered by adoptByPath which calls stem.toLowerCase())
    const { writeFileSync, mkdirSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = join(tmpdir(), `maw-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "# ThClaws Oracle\n\nsome content");
    const stem = extractOracleStem(join(dir, "CLAUDE.md"));
    expect(stem).toBe("thclaws");
  });
});
