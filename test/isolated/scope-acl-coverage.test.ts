import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  evaluateAcl,
  evaluateAclFromDisk,
  loadAllScopes,
  loadTrustFromDisk,
} from "../../src/commands/shared/scope-acl";

let home = "";
const originalHome = process.env.MAW_HOME;
const originalConfigDir = process.env.MAW_CONFIG_DIR;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maw-scope-acl-"));
  process.env.MAW_HOME = home;
  delete process.env.MAW_CONFIG_DIR;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
});

function configPath(...parts: string[]) {
  return join(home, "config", ...parts);
}

function writeScope(name: string, value: unknown) {
  mkdirSync(configPath("scopes"), { recursive: true });
  writeFileSync(configPath("scopes", `${name}.json`), typeof value === "string" ? value : JSON.stringify(value));
}

function writeTrust(value: unknown) {
  mkdirSync(configPath(), { recursive: true });
  writeFileSync(configPath("trust.json"), typeof value === "string" ? value : JSON.stringify(value));
}

describe("scope ACL coverage", () => {
  test("evaluateAcl allows self messages, shared-scope messages, and symmetric trust pairs", () => {
    const scopes = [
      { name: "ops", members: ["alpha", "beta"], createdAt: "now" },
      { name: "solo", members: ["gamma"], createdAt: "now" },
    ];

    expect(evaluateAcl("alpha", "alpha", [])).toBe("allow");
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("allow");
    expect(evaluateAcl("beta", "alpha", [], [{ sender: "alpha", target: "beta" }])).toBe("allow");
    expect(evaluateAcl("alpha", "gamma", scopes, [{ sender: "delta", target: "epsilon" }])).toBe("queue");
  });

  test("loadAllScopes returns empty for missing dirs and filters corrupt, non-json, and malformed scope files", () => {
    expect(loadAllScopes()).toEqual([]);

    writeScope("zeta", { name: "zeta", members: ["z"], createdAt: "ignored" });
    writeScope("alpha", { name: "alpha", members: ["a", "b"] });
    writeScope("bad-json", "{");
    writeScope("missing-members", { name: "broken" });
    writeFileSync(configPath("scopes", "notes.txt"), JSON.stringify({ name: "txt", members: ["x"] }));

    expect(loadAllScopes()).toEqual([
      { name: "alpha", members: ["a", "b"] },
      { name: "zeta", members: ["z"], createdAt: "ignored" },
    ]);
  });

  test("loadTrustFromDisk strips timestamps and forgives missing, malformed, and wrong-shaped trust files", () => {
    expect(loadTrustFromDisk()).toEqual([]);

    writeTrust("{");
    expect(loadTrustFromDisk()).toEqual([]);

    writeTrust({ sender: "not", target: "array" });
    expect(loadTrustFromDisk()).toEqual([]);

    writeTrust([
      { sender: "alpha", target: "beta", addedAt: "2026-05-18T00:00:00Z" },
      { sender: "missing", target: "timestamp" },
      { sender: 7, target: "bad", addedAt: "now" },
    ]);
    expect(loadTrustFromDisk()).toEqual([{ sender: "alpha", target: "beta" }]);
  });

  test("evaluateAclFromDisk composes scope and trust loaders with queue fallback", () => {
    writeScope("ops", { name: "ops", members: ["alpha", "beta"] });
    writeTrust([{ sender: "gamma", target: "delta", addedAt: "2026-05-18T00:00:00Z" }]);

    expect(evaluateAclFromDisk("alpha", "beta")).toBe("allow");
    expect(evaluateAclFromDisk("delta", "gamma")).toBe("allow");
    expect(evaluateAclFromDisk("alpha", "gamma")).toBe("queue");
  });
});
