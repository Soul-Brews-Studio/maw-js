/** Pure wake-resolver coverage for high-signal name normalization guards. */
import { describe, expect, test } from "bun:test";
import {
  resolveLocalOracleRepoName,
  sanitizeBranchName,
} from "../src/commands/shared/wake-resolve-impl";

describe("sanitizeBranchName — pure normalization", () => {
  test("strips repeated leading/trailing dashes and dots", () => {
    expect(sanitizeBranchName("--no-attach")).toBe("no-attach");
    expect(sanitizeBranchName("...feature...")).toBe("feature");
    expect(sanitizeBranchName("--foo--")).toBe("foo");
  });

  test("normalizes whitespace, case, punctuation, and length", () => {
    expect(sanitizeBranchName("My Task Name")).toBe("my-task-name");
    expect(sanitizeBranchName("Feature: Pulse Board!")).toBe("feature-pulse-board");
    expect(sanitizeBranchName("x".repeat(80))).toHaveLength(50);
  });

  test("collapses pure separator input to empty string", () => {
    expect(sanitizeBranchName("--")).toBe("");
    expect(sanitizeBranchName("...")).toBe("");
  });
});

describe("resolveLocalOracleRepoName — exact before fuzzy", () => {
  const repos = [
    "github.com/Soul-Brews-Studio/mawjs-oracle",
    "github.com/Soul-Brews-Studio/mawjs-codex-oracle",
    "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
  ];

  test("prefers exact full and bare oracle names over shorter fuzzy suffixes", () => {
    expect(resolveLocalOracleRepoName("mawjs-codex-oracle", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
    expect(resolveLocalOracleRepoName("mawjs-codex", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  test("strips numeric fleet prefixes before exact local lookup", () => {
    expect(resolveLocalOracleRepoName("48-mawjs-codex", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  test("keeps legacy fuzzy lookup for unambiguous abbreviations", () => {
    expect(resolveLocalOracleRepoName("v3", repos)).toEqual({
      kind: "fuzzy",
      match: "arra-oracle-v3-oracle",
    });
  });

  test("fails loud for same oracle name across multiple orgs", () => {
    expect(resolveLocalOracleRepoName("pulse", [
      "github.com/laris-co/pulse-oracle",
      "github.com/Soul-Brews-Studio/pulse-oracle",
    ])).toEqual({
      kind: "ambiguous",
      candidates: [
        "laris-co/pulse-oracle",
        "Soul-Brews-Studio/pulse-oracle",
      ],
    });
  });

  test("returns none for empty or non-oracle inputs", () => {
    expect(resolveLocalOracleRepoName("", repos)).toEqual({ kind: "none" });
    expect(resolveLocalOracleRepoName("ghost", repos)).toEqual({ kind: "none" });
  });
});
