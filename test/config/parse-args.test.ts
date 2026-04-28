/**
 * Tests for parseFlags from src/cli/parse-args.ts.
 * Pure wrapper around `arg` — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { parseFlags } from "../../src/cli/parse-args";

describe("parseFlags", () => {
  it("parses boolean flags", () => {
    const result = parseFlags(["--verbose"], { "--verbose": Boolean });
    expect(result["--verbose"]).toBe(true);
  });

  it("parses string flags", () => {
    const result = parseFlags(["--from", "neo"], { "--from": String });
    expect(result["--from"]).toBe("neo");
  });

  it("collects positional args in _", () => {
    const result = parseFlags(["bud", "neo", "--force"], { "--force": Boolean });
    expect(result._).toContain("bud");
    expect(result._).toContain("neo");
  });

  it("skips leading positionals", () => {
    const result = parseFlags(["bud", "neo", "--force"], { "--force": Boolean }, 1);
    expect(result._).toEqual(["neo"]);
    expect(result["--force"]).toBe(true);
  });

  it("skips multiple leading positionals", () => {
    const result = parseFlags(["oracle", "scan", "--json"], { "--json": Boolean }, 2);
    expect(result._).toEqual([]);
    expect(result["--json"]).toBe(true);
  });

  it("handles unknown flags permissively", () => {
    const result = parseFlags(["--unknown", "value"], { "--known": Boolean });
    // Unknown flags go to positional
    expect(result._).toContain("--unknown");
    expect(result._).toContain("value");
  });

  it("handles empty args", () => {
    const result = parseFlags([], {});
    expect(result._).toEqual([]);
  });

  it("supports flag aliases", () => {
    const result = parseFlags(["-v"], { "--verbose": Boolean, "-v": "--verbose" });
    expect(result["--verbose"]).toBe(true);
  });

  it("handles number-type flags", () => {
    const result = parseFlags(["--limit", "50"], { "--limit": Number });
    expect(result["--limit"]).toBe(50);
  });
});
