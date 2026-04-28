/**
 * Tests for _normalize from src/core/repo-discovery/ghq-discovery.ts.
 * Pure string normalization — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { _normalize } from "../../src/core/repo-discovery/ghq-discovery";

describe("_normalize (ghq output)", () => {
  it("splits output by newlines", () => {
    expect(_normalize("/path/a\n/path/b")).toEqual(["/path/a", "/path/b"]);
  });

  it("filters empty lines", () => {
    expect(_normalize("/path/a\n\n/path/b\n")).toEqual(["/path/a", "/path/b"]);
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(_normalize("C:\\Users\\foo\\repo")).toEqual(["C:/Users/foo/repo"]);
  });

  it("handles empty string", () => {
    expect(_normalize("")).toEqual([]);
  });

  it("handles single path", () => {
    expect(_normalize("/home/user/repo")).toEqual(["/home/user/repo"]);
  });

  it("preserves forward slashes", () => {
    expect(_normalize("/home/user/org/repo")).toEqual(["/home/user/org/repo"]);
  });

  it("handles mixed slashes", () => {
    expect(_normalize("C:\\Users\\foo/bar\\baz")).toEqual(["C:/Users/foo/bar/baz"]);
  });
});
