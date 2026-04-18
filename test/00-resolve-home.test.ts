/**
 * #566 — MAW_HOME resolution and instance-name validation.
 *
 * resolveHome() is the single source of truth for the per-instance maw root.
 * These tests validate the helper's contract + the name-validation regex.
 *
 * NOTE: other test files in this suite (snapshot.test.ts, curl-fetch.test.ts)
 * use `mock.module("../src/core/paths", ...)` which is PROCESS-GLOBAL in
 * bun-test. To keep this test hermetic, we re-register the mock here with a
 * factory that reproduces the real resolveHome() contract. This guarantees
 * the import below gets a real resolver regardless of file ordering.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { join } from "path";
import { homedir } from "os";

// Re-register a "real" mock for src/core/paths with a live resolveHome.
// The constants are unused here but must be present for modules that import
// them (mock.module is an all-or-nothing module substitution).
mock.module("../src/core/paths", () => ({
  MAW_ROOT: "/tmp",
  CONFIG_DIR: join(homedir(), ".config", "maw"),
  FLEET_DIR: join(homedir(), ".config", "maw", "fleet"),
  CONFIG_FILE: join(homedir(), ".config", "maw", "maw.config.json"),
  resolveHome: () => process.env.MAW_HOME || join(homedir(), ".maw"),
}));

const { resolveHome } = await import("../src/core/paths");
const { INSTANCE_NAME_RE } = await import("../src/cli/instance-preset");

describe("resolveHome()", () => {
  const prior = process.env.MAW_HOME;

  afterEach(() => {
    if (prior === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = prior;
  });

  test("returns ~/.maw when MAW_HOME is unset", () => {
    delete process.env.MAW_HOME;
    expect(resolveHome()).toBe(join(homedir(), ".maw"));
  });

  test("returns MAW_HOME when set", () => {
    process.env.MAW_HOME = "/tmp/maw-test-instance-42";
    expect(resolveHome()).toBe("/tmp/maw-test-instance-42");
  });

  test("MAW_HOME set to instance path returns that path", () => {
    const instPath = join(homedir(), ".maw", "inst", "dev");
    process.env.MAW_HOME = instPath;
    expect(resolveHome()).toBe(instPath);
  });
});

describe("INSTANCE_NAME_RE", () => {
  test("accepts valid names", () => {
    expect(INSTANCE_NAME_RE.test("dev")).toBe(true);
    expect(INSTANCE_NAME_RE.test("prod")).toBe(true);
    expect(INSTANCE_NAME_RE.test("node-1")).toBe(true);
    expect(INSTANCE_NAME_RE.test("a")).toBe(true);
    expect(INSTANCE_NAME_RE.test("inst_2")).toBe(true);
    expect(INSTANCE_NAME_RE.test("a1b2c3")).toBe(true);
  });

  test("rejects invalid names", () => {
    expect(INSTANCE_NAME_RE.test("")).toBe(false);
    expect(INSTANCE_NAME_RE.test("-leading-dash")).toBe(false);
    expect(INSTANCE_NAME_RE.test("Upper")).toBe(false);
    expect(INSTANCE_NAME_RE.test("has space")).toBe(false);
    expect(INSTANCE_NAME_RE.test("has.dot")).toBe(false);
    expect(INSTANCE_NAME_RE.test("a".repeat(33))).toBe(false);
  });
});
