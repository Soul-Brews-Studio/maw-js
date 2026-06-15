import { describe, expect, test } from "bun:test";
import { canonicalRepoKey, normalizeGhqRepos } from "./ghq-normalize";

describe("normalizeGhqRepos", () => {
  test("prefers canonical repo path when doubled github.com entry appears first", () => {
    const repos = normalizeGhqRepos([
      "/opt/Code/github.com/github.com/Soul-Brews-Studio/mawjs-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle",
    ]);

    expect(repos).toEqual([
      "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle",
    ]);
  });

  test("deduplicates absolute and ghq-relative github.com repo paths by canonical suffix", () => {
    expect(canonicalRepoKey("github.com/Soul-Brews-Studio/mawjs-oracle")).toBe("soul-brews-studio/mawjs-oracle");

    const repos = normalizeGhqRepos([
      "github.com/Soul-Brews-Studio/mawjs-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle",
    ]);

    expect(repos).toEqual([
      "github.com/Soul-Brews-Studio/mawjs-oracle",
    ]);
  });

  test("filters nested archive ghosts before deduplicating canonical repos", () => {
    const repos = normalizeGhqRepos([
      "/opt/Code/_archive/oracle-world/github.com/Soul-Brews-Studio/mawjs-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle",
    ]);

    expect(repos).toEqual([
      "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle",
    ]);
  });
});
