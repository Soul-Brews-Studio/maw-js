/**
 * Tests for src/plugin/manifest-constants.ts — regex patterns.
 * Pure constants, zero dependencies.
 */
import { describe, it, expect } from "bun:test";
import { NAME_RE, SEMVER_RE, SEMVER_RANGE_RE, KNOWN_CAPABILITY_NAMESPACES } from "../../src/plugin/manifest-constants";

describe("NAME_RE", () => {
  it("accepts lowercase alphanumeric with dashes", () => {
    expect(NAME_RE.test("my-plugin")).toBe(true);
    expect(NAME_RE.test("hello123")).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(NAME_RE.test("MyPlugin")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(NAME_RE.test("my_plugin")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(NAME_RE.test("my plugin")).toBe(false);
  });
});

describe("SEMVER_RE", () => {
  it("accepts N.N.N", () => {
    expect(SEMVER_RE.test("1.0.0")).toBe(true);
    expect(SEMVER_RE.test("0.0.1")).toBe(true);
  });

  it("accepts pre-release", () => {
    expect(SEMVER_RE.test("1.0.0-alpha.1")).toBe(true);
  });

  it("accepts build metadata", () => {
    expect(SEMVER_RE.test("1.0.0+build.42")).toBe(true);
  });

  it("rejects non-semver", () => {
    expect(SEMVER_RE.test("latest")).toBe(false);
    expect(SEMVER_RE.test("1.0")).toBe(false);
  });
});

describe("SEMVER_RANGE_RE", () => {
  it("accepts *", () => {
    expect(SEMVER_RANGE_RE.test("*")).toBe(true);
  });

  it("accepts bare semver", () => {
    expect(SEMVER_RANGE_RE.test("1.0.0")).toBe(true);
  });

  it("accepts ^ prefix", () => {
    expect(SEMVER_RANGE_RE.test("^1.0.0")).toBe(true);
  });

  it("accepts ~ prefix", () => {
    expect(SEMVER_RANGE_RE.test("~1.0.0")).toBe(true);
  });

  it("accepts >= prefix", () => {
    expect(SEMVER_RANGE_RE.test(">=1.0.0")).toBe(true);
  });

  it("rejects npm-style complex ranges", () => {
    expect(SEMVER_RANGE_RE.test(">=1.0.0 <2.0.0")).toBe(false);
  });
});

describe("KNOWN_CAPABILITY_NAMESPACES", () => {
  it("contains expected namespaces", () => {
    expect(KNOWN_CAPABILITY_NAMESPACES.has("net")).toBe(true);
    expect(KNOWN_CAPABILITY_NAMESPACES.has("fs")).toBe(true);
    expect(KNOWN_CAPABILITY_NAMESPACES.has("sdk")).toBe(true);
    expect(KNOWN_CAPABILITY_NAMESPACES.has("proc")).toBe(true);
    expect(KNOWN_CAPABILITY_NAMESPACES.has("ffi")).toBe(true);
    expect(KNOWN_CAPABILITY_NAMESPACES.has("peer")).toBe(true);
  });

  it("does not contain unknown namespaces", () => {
    expect(KNOWN_CAPABILITY_NAMESPACES.has("db")).toBe(false);
  });
});
