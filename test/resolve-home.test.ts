/**
 * #566 — MAW_HOME resolution and instance-name validation.
 *
 * resolveHome() is the single source of truth for the per-instance maw root.
 * CONFIG_DIR etc. derive from it at import time — these tests exercise the
 * helper itself and the validation regex, which are module-import-safe.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import { resolveHome } from "../src/core/paths";
import { INSTANCE_NAME_RE } from "../src/cli/instance-preset";

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
