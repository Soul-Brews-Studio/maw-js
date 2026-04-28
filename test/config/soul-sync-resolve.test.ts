/**
 * Tests for resolveProjectSlug from src/commands/plugins/soul-sync/resolve.ts — pure function.
 */
import { describe, it, expect } from "bun:test";
import { resolveProjectSlug } from "../../src/commands/plugins/soul-sync/resolve";

describe("resolveProjectSlug", () => {
  it("resolves github.com-rooted ghqRoot (Shape A)", () => {
    const slug = resolveProjectSlug(
      "/home/neo/Code/github.com/Soul-Brews-Studio/maw-js",
      "/home/neo/Code/github.com",
    );
    expect(slug).toBe("Soul-Brews-Studio/maw-js");
  });

  it("resolves bare ghq root (Shape B — strips github.com)", () => {
    const slug = resolveProjectSlug(
      "/home/neo/Code/github.com/Soul-Brews-Studio/maw-js",
      "/home/neo/Code",
    );
    expect(slug).toBe("Soul-Brews-Studio/maw-js");
  });

  it("strips gitlab.com host", () => {
    const slug = resolveProjectSlug(
      "/home/user/ghq/gitlab.com/myorg/myrepo",
      "/home/user/ghq",
    );
    expect(slug).toBe("myorg/myrepo");
  });

  it("strips bitbucket.org host", () => {
    const slug = resolveProjectSlug(
      "/home/user/ghq/bitbucket.org/team/project",
      "/home/user/ghq",
    );
    expect(slug).toBe("team/project");
  });

  it("returns null when repoRoot is not under ghqRoot", () => {
    expect(resolveProjectSlug("/other/path/repo", "/home/user/ghq")).toBeNull();
  });

  it("strips .wt-* worktree suffix from repo name", () => {
    const slug = resolveProjectSlug(
      "/home/neo/Code/github.com/Org/my-repo.wt-feature-branch",
      "/home/neo/Code/github.com",
    );
    expect(slug).toBe("Org/my-repo");
  });

  it("returns null for insufficient depth (no org segment)", () => {
    const slug = resolveProjectSlug(
      "/home/user/ghq/lonely-repo",
      "/home/user/ghq",
    );
    expect(slug).toBeNull();
  });

  it("handles trailing slashes in ghqRoot", () => {
    const slug = resolveProjectSlug(
      "/home/user/ghq/github.com/org/repo",
      "/home/user/ghq/",
    );
    // After slice, rel starts with "github.com/org/repo" — should work
    expect(slug).toBe("org/repo");
  });

  it("returns first two segments only (ignores deeper paths)", () => {
    const slug = resolveProjectSlug(
      "/home/user/ghq/github.com/org/repo/sub/dir",
      "/home/user/ghq",
    );
    expect(slug).toBe("org/repo");
  });

  it("handles already-stripped host in github.com-rooted root", () => {
    // ghqRoot IS the github.com dir, so rel is just "org/repo"
    const slug = resolveProjectSlug(
      "/home/user/Code/github.com/MyOrg/cool-project",
      "/home/user/Code/github.com",
    );
    expect(slug).toBe("MyOrg/cool-project");
  });
});
