import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const scope = await import("../../src/vendor/mpr-plugins/scope/impl.ts?coverage-next-vendor-b-scope");

let home: string;
const originalEnv = { MAW_HOME: process.env.MAW_HOME, MAW_CONFIG_DIR: process.env.MAW_CONFIG_DIR };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maw-coverage-next-vendor-b-scope-"));
  process.env.MAW_HOME = home;
  delete process.env.MAW_CONFIG_DIR;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalEnv.MAW_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalEnv.MAW_HOME;
  if (originalEnv.MAW_CONFIG_DIR === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalEnv.MAW_CONFIG_DIR;
});

describe("coverage-next vendor-b scope impl branches", () => {
  test("MAW_HOME drives paths, unreadable scope files are skipped, and formatted rows pad columns", () => {
    expect(scope.scopesDir()).toBe(join(home, "config", "scopes"));
    expect(scope.cmdShow("missing")).toBeNull();

    const created = scope.cmdCreate({
      name: "alpha_scope",
      members: ["neo", "trinity"],
      lead: "neo",
      ttl: "2026-05-19T00:00:00.000Z",
    });
    writeFileSync(join(scope.scopesDir(), "broken.json"), "{", "utf-8");

    expect(created.lead).toBe("neo");
    expect(scope.cmdList().map((row) => row.name)).toEqual(["alpha_scope"]);
    expect(scope.formatList(scope.cmdList())).toContain("alpha_scope");
    expect(scope.cmdDelete("alpha_scope")).toBe(true);
    expect(scope.cmdDelete("alpha_scope")).toBe(false);
  });

  test("create validates empty member entries and lead membership", () => {
    expect(() => scope.cmdCreate({ name: "badempty", members: ["ok", ""] }))
      .toThrow("empty/invalid member");
    expect(() => scope.cmdCreate({ name: "badlead", members: ["ok"], lead: "other" }))
      .toThrow('lead "other" is not in members');
  });
});
