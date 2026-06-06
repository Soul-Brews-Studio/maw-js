/**
 * #1885 — parsePluginFlags pure-function tests.
 *
 * Intentionally lives in test/cli/ (not test/isolated/) and uses ZERO
 * module mocks — the parser is a pure function with no transitive imports
 * into config/, plugin-loader/, or anything that triggers the cfgLimit /
 * cfgTimeout mock cascade observed in CI for #1882/#1912.
 */
import { describe, test, expect } from "bun:test";
import { parsePluginFlags, type ManifestFlagType } from "../../src/cli/dispatch-flag-parse";

describe("parsePluginFlags (#1885)", () => {
  test("boolean flag present → true", () => {
    const result = parsePluginFlags({ "--bare": "boolean" }, ["--bare"]);
    expect(result).toEqual({ bare: true });
  });

  test("boolean flag absent → omitted from result", () => {
    const result = parsePluginFlags({ "--bare": "boolean" }, []);
    expect(result).toEqual({});
  });

  test("string flag with separate value", () => {
    const result = parsePluginFlags({ "--team-id": "string" }, ["--team-id", "abc-123"]);
    expect(result).toEqual({ "team-id": "abc-123" });
  });

  test("string flag with =value form", () => {
    const result = parsePluginFlags({ "--team-id": "string" }, ["--team-id=abc-123"]);
    expect(result).toEqual({ "team-id": "abc-123" });
  });

  test("number flag with valid value", () => {
    const result = parsePluginFlags({ "--days": "number" }, ["--days", "7"]);
    expect(result).toEqual({ days: 7 });
  });

  test("number flag with =value", () => {
    const result = parsePluginFlags({ "--days": "number" }, ["--days=42"]);
    expect(result).toEqual({ days: 42 });
  });

  test("number flag with non-numeric value silently skipped", () => {
    const result = parsePluginFlags({ "--days": "number" }, ["--days", "lots"]);
    expect(result).toEqual({});
  });

  test("string[] flag collects multiple values in order", () => {
    const result = parsePluginFlags(
      { "--tag": "string[]" },
      ["--tag", "alpha", "--tag", "beta", "--tag=gamma"],
    );
    expect(result).toEqual({ tag: ["alpha", "beta", "gamma"] });
  });

  test("multiple flag types in one argv", () => {
    const result = parsePluginFlags(
      { "--bare": "boolean", "--team-id": "string", "--days": "number" },
      ["--bare", "--team-id", "abc", "--days=7"],
    );
    expect(result).toEqual({ bare: true, "team-id": "abc", days: 7 });
  });

  test("repeated string flag — last wins", () => {
    const result = parsePluginFlags(
      { "--name": "string" },
      ["--name", "first", "--name", "second"],
    );
    expect(result).toEqual({ name: "second" });
  });

  test("repeated boolean flag — still true", () => {
    const result = parsePluginFlags(
      { "--verbose": "boolean" },
      ["--verbose", "--verbose"],
    );
    expect(result).toEqual({ verbose: true });
  });

  test("undeclared flag skipped", () => {
    const result = parsePluginFlags(
      { "--known": "string" },
      ["--unknown", "value", "--known", "x"],
    );
    expect(result).toEqual({ known: "x" });
  });

  test("positional args between flags ignored", () => {
    const result = parsePluginFlags(
      { "--bare": "boolean", "--name": "string" },
      ["positional1", "--bare", "positional2", "--name", "x"],
    );
    expect(result).toEqual({ bare: true, name: "x" });
  });

  test("everything after -- is ignored", () => {
    const result = parsePluginFlags(
      { "--bare": "boolean", "--name": "string" },
      ["--bare", "--", "--name", "ignored"],
    );
    expect(result).toEqual({ bare: true });
  });

  test("negative number doesn't get treated as a flag", () => {
    const result = parsePluginFlags(
      { "--threshold": "number" },
      ["--threshold", "-5"],
    );
    expect(result).toEqual({ threshold: -5 });
  });

  test("missing value for string flag — silently skipped", () => {
    const result = parsePluginFlags(
      { "--name": "string" },
      ["--name"],
    );
    expect(result).toEqual({});
  });

  test("missing value when flag is last → skipped", () => {
    const result = parsePluginFlags(
      { "--bare": "boolean", "--name": "string" },
      ["--bare", "--name"],
    );
    expect(result).toEqual({ bare: true });
  });

  test("empty argv → empty result", () => {
    const result = parsePluginFlags({ "--bare": "boolean" }, []);
    expect(result).toEqual({});
  });

  test("empty declared schema → empty result regardless of argv", () => {
    const result = parsePluginFlags({}, ["--bare", "--name", "x"]);
    expect(result).toEqual({});
  });

  test("=empty value treated as empty string", () => {
    const result = parsePluginFlags(
      { "--name": "string" },
      ["--name="],
    );
    expect(result).toEqual({ name: "" });
  });

  test("real-world team-agent example from issue body", () => {
    const result = parsePluginFlags(
      { "--bare": "boolean", "--team-id": "string" },
      ["uuid", "--bare"],
    );
    expect(result).toEqual({ bare: true });

    const result2 = parsePluginFlags(
      { "--bare": "boolean", "--team-id": "string" },
      ["create", "x", "desc", "--team-id", "00000130-abcd"],
    );
    expect(result2).toEqual({ "team-id": "00000130-abcd" });
  });

  test("schema with unused declared flags → only present flags in result", () => {
    const declared: Record<string, ManifestFlagType> = {
      "--a": "boolean",
      "--b": "string",
      "--c": "number",
      "--d": "string[]",
    };
    const result = parsePluginFlags(declared, ["--b", "value-b"]);
    expect(result).toEqual({ b: "value-b" });
    expect(result.a).toBeUndefined();
    expect(result.c).toBeUndefined();
    expect(result.d).toBeUndefined();
  });
});
