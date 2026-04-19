import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { parseRemoteUrl, readOriginRemote, resolveSlug } from "./from-repo-fleet";

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

describe("from-repo-fleet: readOriginRemote shell-injection guard (#474)", () => {
  // execFileSync + argv ensures shell metacharacters in `target` are treated
  // as literal path bytes, not shell syntax. Regression guard for the
  // js/indirect-command-line-injection sink on line 38 (pre-fix).
  it("does not execute injected commands via target path", () => {
    const sentinel = mkdtempSync(join(tmpdir(), "maw-inject-sentinel-"));
    const marker = join(sentinel, "pwned");
    try {
      // A shell-interpreted execSync(`git -C ${target} …`) would run `touch`
      // through $(…) substitution. With execFileSync + argv, the whole
      // string is passed as a single -C path → git fails, marker stays absent.
      const malicious = `/tmp/nonexistent$(touch ${marker})`;
      const result = readOriginRemote(malicious);
      expect(result).toBeNull();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(sentinel, { recursive: true, force: true });
    }
  });

  it("returns null for a path with no git repo (benign)", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-no-git-"));
    try {
      expect(readOriginRemote(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
