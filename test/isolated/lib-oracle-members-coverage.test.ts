/** @maw-test-isolate @maw-test-isolate-cwd-neutral */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-lib-oracle-members-"));
const STATE_DIR = mkdtempSync(join(tmpdir(), "maw-lib-oracle-members-state-"));
const ORIGINAL_MAW_CONFIG_DIR = process.env.MAW_CONFIG_DIR;
const ORIGINAL_MAW_STATE_DIR = process.env.MAW_STATE_DIR;
process.env.MAW_CONFIG_DIR = CONFIG_DIR;
process.env.MAW_STATE_DIR = STATE_DIR;

const { filterMembers, getOracleMembers, loadOracleRegistry } = await import(
  "../../src/lib/oracle-members.ts?lib-oracle-members-coverage"
);

function registryPath(team: string): string {
  return join(STATE_DIR, "teams", team, "oracle-members.json");
}

function legacyRegistryPath(team: string): string {
  return join(CONFIG_DIR, "teams", team, "oracle-members.json");
}

function writeRegistry(team: string, body: unknown): void {
  const path = registryPath(team);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

function writeLegacyRegistry(team: string, body: unknown): void {
  const path = legacyRegistryPath(team);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

beforeEach(() => {
  rmSync(join(CONFIG_DIR, "teams"), { recursive: true, force: true });
  rmSync(join(STATE_DIR, "teams"), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  if (ORIGINAL_MAW_CONFIG_DIR === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = ORIGINAL_MAW_CONFIG_DIR;
  if (ORIGINAL_MAW_STATE_DIR === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = ORIGINAL_MAW_STATE_DIR;
});

describe("lib oracle-members coverage", () => {
  test("loadOracleRegistry is fail-soft for absent and malformed registries", () => {
    expect(loadOracleRegistry("missing")).toBeNull();

    writeRegistry("broken", "{not-json");

    expect(loadOracleRegistry("broken")).toBeNull();
    expect(getOracleMembers("broken", "lead")).toEqual([]);
  });

  test("getOracleMembers loads members and filters current sender by default", () => {
    writeRegistry("alchemy", {
      name: "alchemy",
      createdAt: "2026-05-18T00:00:00.000Z",
      members: [
        { oracle: "lead", role: "lead", addedAt: "2026-05-18T00:00:00.000Z" },
        { oracle: "builder", role: "builder", addedAt: "2026-05-18T00:00:00.000Z" },
      ],
    });

    expect(loadOracleRegistry("alchemy")?.name).toBe("alchemy");
    expect(getOracleMembers("alchemy")).toEqual(["lead", "builder"]);
    expect(getOracleMembers("alchemy", "lead")).toEqual(["builder"]);
  });

  test("filterMembers honors explicit include-self and no-current-oracle branches", () => {
    const members = [
      { oracle: "lead", role: "lead", addedAt: "2026-05-18T00:00:00.000Z" },
      { oracle: "reviewer", role: "reviewer", addedAt: "2026-05-18T00:00:00.000Z" },
    ];

    expect(filterMembers(members, true, "lead")).toEqual(["reviewer"]);
    expect(filterMembers(members, undefined, "lead")).toEqual(["reviewer"]);
    expect(filterMembers(members, false, "lead")).toEqual(["lead", "reviewer"]);
    expect(filterMembers(members, undefined)).toEqual(["lead", "reviewer"]);
  });

  test("registry excludeSelf=false keeps the sender in fan-out results", () => {
    writeRegistry("inclusive", {
      name: "inclusive",
      createdAt: "2026-05-18T00:00:00.000Z",
      excludeSelf: false,
      members: [
        { oracle: "lead", role: "lead", addedAt: "2026-05-18T00:00:00.000Z" },
        { oracle: "reviewer", role: "reviewer", addedAt: "2026-05-18T00:00:00.000Z" },
      ],
    });

    expect(getOracleMembers("inclusive", "lead")).toEqual(["lead", "reviewer"]);
  });

  test("legacy config registries remain readable when no state registry exists", () => {
    writeLegacyRegistry("legacy", {
      name: "legacy",
      createdAt: "2026-05-20T00:00:00.000Z",
      members: [
        { oracle: "legacy-lead", role: "lead", addedAt: "2026-05-20T00:00:00.000Z" },
      ],
    });

    expect(loadOracleRegistry("legacy")?.name).toBe("legacy");
    expect(getOracleMembers("legacy")).toEqual(["legacy-lead"]);
  });
});
