import { describe, test, expect } from "bun:test";
import { parseWakeTarget } from "../src/commands/wake-resolve";

describe("parseWakeTarget — GitHub URLs", () => {
  test("basic HTTPS URL", () => {
    const r = parseWakeTarget("https://github.com/org/repo");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo" });
  });

  test("strips -oracle suffix from oracle name", () => {
    const r = parseWakeTarget("https://github.com/org/repo-oracle");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo-oracle" });
  });

  test("strips .git suffix", () => {
    const r = parseWakeTarget("https://github.com/org/repo.git");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo" });
  });

  test("HTTP without TLS", () => {
    const r = parseWakeTarget("http://github.com/org/repo");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo" });
  });

  test("git@ SSH with .git", () => {
    const r = parseWakeTarget("git@github.com:org/repo.git");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo" });
  });

  test("git@ SSH without .git", () => {
    const r = parseWakeTarget("git@github.com:org/repo");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo" });
  });

  test("extracts issue number from URL", () => {
    const r = parseWakeTarget("https://github.com/org/repo/issues/42");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo", issueNum: 42 });
  });

  test("extracts issue number and strips -oracle suffix", () => {
    const r = parseWakeTarget("https://github.com/org/repo-oracle/issues/7");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo-oracle", issueNum: 7 });
  });

  test("trailing slash is ignored", () => {
    const r = parseWakeTarget("https://github.com/org/repo/");
    expect(r).toEqual({ oracle: "repo", slug: "org/repo" });
  });

  test("real-world long org name with -oracle repo (Nat's use case)", () => {
    const r = parseWakeTarget("https://github.com/the-oracle-keeps-the-human-human/graph-oracle");
    expect(r).toEqual({ oracle: "graph", slug: "the-oracle-keeps-the-human-human/graph-oracle" });
  });
});

describe("parseWakeTarget — org/repo slugs", () => {
  test("Soul-Brews-Studio/mawjs-oracle → oracle 'mawjs', slug preserved", () => {
    const r = parseWakeTarget("Soul-Brews-Studio/mawjs-oracle");
    expect(r).not.toBeNull();
    expect(r!.oracle).toBe("mawjs");
    expect(r!.slug).toBe("Soul-Brews-Studio/mawjs-oracle");
    expect(r!.issueNum).toBeUndefined();
  });

  test("acme/my-project → oracle 'my-project' (no -oracle suffix)", () => {
    const r = parseWakeTarget("acme/my-project");
    expect(r).not.toBeNull();
    expect(r!.oracle).toBe("my-project");
    expect(r!.slug).toBe("acme/my-project");
  });

  test("acme/my-project.git → strips .git suffix", () => {
    const r = parseWakeTarget("acme/my-project.git");
    expect(r).not.toBeNull();
    expect(r!.oracle).toBe("my-project");
    expect(r!.slug).toBe("acme/my-project");
  });

  test("long org name with -oracle suffix stripped (Nat's real case)", () => {
    const r = parseWakeTarget("the-oracle-keeps-the-human-human/graph-oracle");
    expect(r).not.toBeNull();
    expect(r!.oracle).toBe("graph");
    expect(r!.slug).toBe("the-oracle-keeps-the-human-human/graph-oracle");
  });

  test("leading/trailing whitespace is trimmed", () => {
    const r = parseWakeTarget("  Soul-Brews-Studio/mawjs-oracle  ");
    expect(r).not.toBeNull();
    expect(r!.oracle).toBe("mawjs");
    expect(r!.slug).toBe("Soul-Brews-Studio/mawjs-oracle");
  });
});

describe("parseWakeTarget — null returns (plain oracle names)", () => {
  test("bare name 'neo' → null", () => {
    expect(parseWakeTarget("neo")).toBeNull();
  });

  test("hyphenated bare name 'maw-js' → null", () => {
    expect(parseWakeTarget("maw-js")).toBeNull();
  });

  test("keyword 'all' → null", () => {
    expect(parseWakeTarget("all")).toBeNull();
  });

  test("multi-segment path 'a/b/c' → null (not a valid slug)", () => {
    expect(parseWakeTarget("a/b/c")).toBeNull();
  });

  test("absolute path '/home/user/repo' → null", () => {
    expect(parseWakeTarget("/home/user/repo")).toBeNull();
  });

  test("flag-like arg '--flag' → null", () => {
    expect(parseWakeTarget("--flag")).toBeNull();
  });

  test("empty string → null", () => {
    expect(parseWakeTarget("")).toBeNull();
  });
});
