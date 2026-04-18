import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { parseRemoteUrl, resolveSlug } from "./from-repo-fleet";

function mkGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-fleet-test-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

describe("from-repo-fleet: parseRemoteUrl", () => {
  it("parses git@github.com:org/repo.git", () => {
    expect(parseRemoteUrl("git@github.com:Soul-Brews-Studio/maw-js.git"))
      .toEqual({ org: "Soul-Brews-Studio", repo: "maw-js" });
  });

  it("parses https URL with .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/Soul-Brews-Studio/maw-js.git"))
      .toEqual({ org: "Soul-Brews-Studio", repo: "maw-js" });
  });

  it("parses https URL without .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/x/y"))
      .toEqual({ org: "x", repo: "y" });
  });

  it("returns null on garbage", () => {
    expect(parseRemoteUrl("not-a-url")).toBeNull();
  });
});

describe("from-repo-fleet: resolveSlug", () => {
  it("falls back to <unknown>/<basename> when no remote", () => {
    const dir = mkGitRepo();
    try {
      const slug = resolveSlug(dir);
      expect(slug.org).toBe("<unknown>");
      expect(slug.repo).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
