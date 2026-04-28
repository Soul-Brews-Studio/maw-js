/**
 * Tests for INSTANCE_NAME_RE from src/cli/instance-preset.ts.
 * Tests the regex only — applyInstancePreset calls process.exit which is not testable purely.
 */
import { describe, it, expect } from "bun:test";
import { INSTANCE_NAME_RE } from "../../src/cli/instance-preset";

describe("INSTANCE_NAME_RE", () => {
  it("accepts simple lowercase names", () => {
    expect(INSTANCE_NAME_RE.test("dev")).toBe(true);
    expect(INSTANCE_NAME_RE.test("prod")).toBe(true);
    expect(INSTANCE_NAME_RE.test("staging")).toBe(true);
  });

  it("accepts names with digits", () => {
    expect(INSTANCE_NAME_RE.test("dev1")).toBe(true);
    expect(INSTANCE_NAME_RE.test("node42")).toBe(true);
  });

  it("accepts names with dashes and underscores", () => {
    expect(INSTANCE_NAME_RE.test("my-instance")).toBe(true);
    expect(INSTANCE_NAME_RE.test("my_instance")).toBe(true);
  });

  it("accepts names starting with digit", () => {
    expect(INSTANCE_NAME_RE.test("1dev")).toBe(true);
  });

  it("rejects names starting with dash", () => {
    expect(INSTANCE_NAME_RE.test("-dev")).toBe(false);
  });

  it("rejects names starting with underscore", () => {
    expect(INSTANCE_NAME_RE.test("_dev")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(INSTANCE_NAME_RE.test("Dev")).toBe(false);
    expect(INSTANCE_NAME_RE.test("DEV")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(INSTANCE_NAME_RE.test("")).toBe(false);
  });

  it("rejects strings longer than 32 chars", () => {
    expect(INSTANCE_NAME_RE.test("a".repeat(33))).toBe(false);
  });

  it("accepts strings up to 32 chars", () => {
    expect(INSTANCE_NAME_RE.test("a".repeat(32))).toBe(true);
  });

  it("rejects special characters", () => {
    expect(INSTANCE_NAME_RE.test("dev.1")).toBe(false);
    expect(INSTANCE_NAME_RE.test("dev@1")).toBe(false);
    expect(INSTANCE_NAME_RE.test("dev 1")).toBe(false);
    expect(INSTANCE_NAME_RE.test("dev/1")).toBe(false);
  });
});
