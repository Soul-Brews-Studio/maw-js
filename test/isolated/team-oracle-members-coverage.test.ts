import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-team-oracle-members-"));
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "maw-team-oracle-members-state-"));
const ORIGINAL_MAW_CONFIG_DIR = process.env.MAW_CONFIG_DIR;
const ORIGINAL_MAW_STATE_DIR = process.env.MAW_STATE_DIR;
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.MAW_STATE_DIR = TEST_STATE_DIR;

const {
  cmdOracleInvite,
  cmdOracleMembers,
  cmdOracleRemove,
  filterMembers,
  getOracleMembers,
  loadOracleRegistry,
} = await import("../../src/vendor/mpr-plugins/team/oracle-members");

const originalLog = console.log;
let logs: string[] = [];

function registryPath(teamName: string) {
  return join(TEST_STATE_DIR, "teams", teamName, "oracle-members.json");
}

function legacyRegistryPath(teamName: string) {
  return join(TEST_CONFIG_DIR, "teams", teamName, "oracle-members.json");
}

function readRegistry(teamName: string) {
  return JSON.parse(readFileSync(registryPath(teamName), "utf-8"));
}

function writeRegistry(teamName: string, registry: Record<string, unknown>) {
  writeFileSync(registryPath(teamName), JSON.stringify(registry, null, 2));
}

function writeLegacyRegistry(teamName: string, registry: Record<string, unknown>) {
  const path = legacyRegistryPath(teamName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2));
}

beforeEach(() => {
  rmSync(join(TEST_CONFIG_DIR, "teams"), { recursive: true, force: true });
  rmSync(join(TEST_STATE_DIR, "teams"), { recursive: true, force: true });
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  if (ORIGINAL_MAW_CONFIG_DIR === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = ORIGINAL_MAW_CONFIG_DIR;
  if (ORIGINAL_MAW_STATE_DIR === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = ORIGINAL_MAW_STATE_DIR;
});

describe("team oracle members isolated coverage", () => {
  test("invite creates a registry with a default role and list returns persisted members", () => {
    cmdOracleInvite("alchemy", "scout");

    const registry = readRegistry("alchemy");
    expect(registry.name).toBe("alchemy");
    expect(registry.createdAt).toEqual(expect.any(String));
    expect(registry.members).toEqual([
      { oracle: "scout", role: "member", addedAt: expect.any(String) },
    ]);
    expect(logs.join("\n")).toContain("added 'scout' to team 'alchemy' (role: member)");
    expect(logs.join("\n")).toContain(registryPath("alchemy"));

    logs = [];
    const listed = cmdOracleMembers("alchemy");

    expect(listed).toEqual(registry.members);
    expect(logs.join("\n")).toContain("Oracle members of 'alchemy'");
    expect(logs.join("\n")).toContain("scout");
    expect(logs.join("\n")).toContain("role:");
  });

  test("re-inviting an oracle updates its role and timestamp without duplicating it", () => {
    cmdOracleInvite("alchemy", "builder", { role: "researcher" });
    const firstAddedAt = readRegistry("alchemy").members[0].addedAt;

    cmdOracleInvite("alchemy", "builder", { role: "reviewer" });

    const registry = readRegistry("alchemy");
    expect(registry.members).toHaveLength(1);
    expect(registry.members[0]).toEqual({
      oracle: "builder",
      role: "reviewer",
      addedAt: expect.any(String),
    });
    expect(registry.members[0].addedAt >= firstAddedAt).toBe(true);
    expect(logs.join("\n")).toContain("updated 'builder' in team 'alchemy' (role: reviewer)");
  });

  test("remove handles missing registries, non-members, and successful deletion", () => {
    cmdOracleRemove("missing", "ghost");
    expect(logs.at(-1)).toContain("team 'missing' has no oracle member registry");

    cmdOracleInvite("alchemy", "scout", { role: "researcher" });
    logs = [];

    cmdOracleRemove("alchemy", "ghost");
    expect(logs.at(-1)).toContain("'ghost' is not a member of team 'alchemy'");
    expect(readRegistry("alchemy").members).toHaveLength(1);

    cmdOracleRemove("alchemy", "scout");
    expect(logs.at(-1)).toContain("removed 'scout' from team 'alchemy'");
    expect(readRegistry("alchemy").members).toEqual([]);
  });

  test("list and load return empty/null for absent, empty, and malformed registries", () => {
    expect(loadOracleRegistry("missing")).toBeNull();
    expect(cmdOracleMembers("missing")).toEqual([]);
    expect(logs.join("\n")).toContain("No oracle members in team 'missing'.");
    expect(logs.join("\n")).toContain("maw team oracle-invite <oracle-name> --team missing");

    cmdOracleInvite("empty", "transient");
    cmdOracleRemove("empty", "transient");
    logs = [];
    expect(cmdOracleMembers("empty")).toEqual([]);
    expect(logs.join("\n")).toContain("No oracle members in team 'empty'.");

    writeFileSync(registryPath("empty"), "{not-json");
    expect(loadOracleRegistry("empty")).toBeNull();
    expect(cmdOracleMembers("empty")).toEqual([]);
  });

  test("getOracleMembers filters the sender by default and honors excludeSelf false", () => {
    cmdOracleInvite("routing", "lead", { role: "lead" });
    cmdOracleInvite("routing", "builder", { role: "builder" });
    cmdOracleInvite("routing", "reviewer", { role: "reviewer" });

    expect(getOracleMembers("routing")).toEqual(["lead", "builder", "reviewer"]);
    expect(getOracleMembers("routing", "lead")).toEqual(["builder", "reviewer"]);

    const registry = readRegistry("routing");
    registry.excludeSelf = false;
    writeRegistry("routing", registry);

    expect(getOracleMembers("routing", "lead")).toEqual(["lead", "builder", "reviewer"]);
    expect(getOracleMembers("missing", "lead")).toEqual([]);
  });

  test("filterMembers covers excludeSelf combinations as a pure helper", () => {
    const members = [
      { oracle: "lead", role: "lead", addedAt: "2026-01-01T00:00:00.000Z" },
      { oracle: "builder", role: "builder", addedAt: "2026-01-02T00:00:00.000Z" },
    ];

    expect(filterMembers(members, undefined, "lead")).toEqual(["builder"]);
    expect(filterMembers(members, true, "lead")).toEqual(["builder"]);
    expect(filterMembers(members, false, "lead")).toEqual(["lead", "builder"]);
    expect(filterMembers(members, undefined)).toEqual(["lead", "builder"]);
  });

  test("registry files stay inside the temporary MAW_STATE_DIR", () => {
    cmdOracleInvite("sandboxed", "oracle");

    expect(existsSync(registryPath("sandboxed"))).toBe(true);
    expect(registryPath("sandboxed").startsWith(TEST_STATE_DIR)).toBe(true);
    expect(existsSync(legacyRegistryPath("sandboxed"))).toBe(false);
  });

  test("legacy config registries stay readable and next mutation writes state", () => {
    writeLegacyRegistry("legacy", {
      name: "legacy",
      createdAt: "2026-05-20T00:00:00.000Z",
      members: [{ oracle: "old", role: "builder", addedAt: "2026-05-20T00:00:00.000Z" }],
    });

    expect(getOracleMembers("legacy")).toEqual(["old"]);

    cmdOracleInvite("legacy", "new", { role: "reviewer" });

    expect(existsSync(registryPath("legacy"))).toBe(true);
    expect(readRegistry("legacy").members.map((m: { oracle: string }) => m.oracle)).toEqual(["old", "new"]);
  });
});
