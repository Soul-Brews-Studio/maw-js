/**
 * Tests for src/commands/plugins/bud/from-repo-fleet.ts — parseRemoteUrl.
 * Pure string parser for git remote URLs.
 */
import { describe, it, expect } from "bun:test";
import { parseRemoteUrl } from "../../src/commands/plugins/bud/from-repo-fleet";

describe("parseRemoteUrl", () => {
  it("parses SSH remote (git@github.com:org/repo.git)", () => {
    expect(parseRemoteUrl("git@github.com:myorg/myrepo.git")).toEqual({
      org: "myorg",
      repo: "myrepo",
    });
  });

  it("parses HTTPS remote with .git", () => {
    expect(parseRemoteUrl("https://github.com/org/repo.git")).toEqual({
      org: "org",
      repo: "repo",
    });
  });

  it("parses HTTPS remote without .git", () => {
    expect(parseRemoteUrl("https://github.com/org/repo")).toEqual({
      org: "org",
      repo: "repo",
    });
  });

  it("strips trailing .git", () => {
    const result = parseRemoteUrl("git@github.com:soul-brews/maw-js.git");
    expect(result!.repo).toBe("maw-js");
  });

  it("handles gitlab URLs", () => {
    expect(parseRemoteUrl("https://gitlab.com/team/project")).toEqual({
      org: "team",
      repo: "project",
    });
  });

  it("handles custom git hosts", () => {
    expect(parseRemoteUrl("git@git.internal.com:infra/deploy-scripts.git")).toEqual({
      org: "infra",
      repo: "deploy-scripts",
    });
  });

  it("returns null for invalid URL", () => {
    expect(parseRemoteUrl("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRemoteUrl("")).toBeNull();
  });

  it("trims whitespace", () => {
    const result = parseRemoteUrl("  https://github.com/org/repo.git  ");
    expect(result).toEqual({ org: "org", repo: "repo" });
  });

  it("handles repo with hyphens and dots", () => {
    expect(parseRemoteUrl("git@github.com:org/my-repo.v2.git")).toEqual({
      org: "org",
      repo: "my-repo.v2",
    });
  });
});
