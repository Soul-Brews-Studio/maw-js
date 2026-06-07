import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { setRunOverride, type RunOptions, type RunResult } from "../../src/vendor/mpr-plugins/token/lib";
import {
  cmdScan,
  findEnvrcFiles,
  formatScan,
  resolveGhqRoot,
} from "../../src/vendor/mpr-plugins/token/scan";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "maw-token-scan-"));

let sandbox = "";
let homeDir = "";
let ghqRoot = "";
let ghqGithubRoot = "";

function resetSandbox() {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = mkdtempSync(join(TMP_ROOT, "case-"));
  homeDir = join(sandbox, "home");
  ghqRoot = join(sandbox, "ghq");
  ghqGithubRoot = join(ghqRoot, "github.com");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(ghqGithubRoot, { recursive: true });
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function result(ok: boolean, stdout = "", stderr = "", exitCode = ok ? 0 : 1): RunResult {
  return { ok, stdout, stderr, exitCode };
}

beforeEach(() => {
  resetSandbox();
  setRunOverride(null);
});

afterEach(() => {
  setRunOverride(null);
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = "";
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("token scan coverage", () => {
  test("resolveGhqRoot handles failed, empty, missing, and valid ghq roots", () => {
    setRunOverride(() => result(false, "", "ghq missing"));
    expect(resolveGhqRoot()).toBeNull();

    setRunOverride(() => result(true, "   \n"));
    expect(resolveGhqRoot()).toBeNull();

    setRunOverride(() => result(true, `${ghqRoot}\n`));
    rmSync(ghqGithubRoot, { recursive: true, force: true });
    expect(resolveGhqRoot()).toBeNull();

    mkdirSync(ghqGithubRoot, { recursive: true });
    expect(resolveGhqRoot()).toBe(ghqGithubRoot);
  });

  test("findEnvrcFiles keeps home first, sorts repos, and ignores non-directories", () => {
    write(join(homeDir, ".envrc"), "export HOME_TOKEN=1\n");
    write(join(ghqGithubRoot, "beta", "zeta", ".envrc"), "export Z=1\n");
    write(join(ghqGithubRoot, "alpha", "bravo", ".envrc"), "export B=1\n");
    write(join(ghqGithubRoot, "alpha", "charlie", "README.md"), "missing envrc\n");
    write(join(ghqGithubRoot, "alpha-file"), "not an org dir\n");
    write(join(ghqGithubRoot, "beta", "repo-file"), "not a repo dir\n");

    expect(findEnvrcFiles(join(sandbox, "missing"), homeDir)).toEqual([
      { label: "~", path: join(homeDir, ".envrc") },
    ]);

    expect(findEnvrcFiles(ghqGithubRoot, homeDir)).toEqual([
      { label: "~", path: join(homeDir, ".envrc") },
      { label: "alpha/bravo", path: join(ghqGithubRoot, "alpha", "bravo", ".envrc") },
      { label: "beta/zeta", path: join(ghqGithubRoot, "beta", "zeta", ".envrc") },
    ]);
  });

  test("cmdScan reports an explicit error when ghq root is unavailable", () => {
    setRunOverride(() => result(false, "", "ghq missing"));

    expect(cmdScan({ home: homeDir })).toEqual({
      ok: false,
      rows: [],
      ghqRoot: null,
      error:
        "ghq root unavailable — install ghq or set up ~/ghq/github.com (no hardcoded fallback)",
    });
  });

  test("cmdScan classifies named, matched, and unmatched envrc files", () => {
    write(join(homeDir, ".envrc"), 'export CLAUDE_TOKEN_NAME="home-main"\n');
    write(
      join(ghqGithubRoot, "acme", "matched-repo", ".envrc"),
      'export CLAUDE_CODE_OAUTH_TOKEN="secret-token-12345678"\n',
    );
    write(
      join(ghqGithubRoot, "acme", "unknown-repo", ".envrc"),
      'export CLAUDE_CODE_OAUTH_TOKEN="mystery-token-value"\n',
    );
    write(join(ghqGithubRoot, "acme", "ignored-repo", ".envrc"), "export SOMETHING_ELSE=1\n");

    setRunOverride((cmd: string[], _opts?: RunOptions) => {
      if (cmd[0] === "ghq" && cmd[1] === "root") return result(true, `${ghqRoot}\n`);
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "claude") {
        return result(true, "token-matcher\ntoken-unused\n");
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-matcher") {
        return result(true, "secret-token-12345678\n");
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-unused") {
        return result(true, "other-secret-87654321\n");
      }
      return result(false, "", `unexpected command: ${cmd.join(" ")}`);
    });

    const scan = cmdScan({ home: homeDir });

    expect(scan).toEqual({
      ok: true,
      ghqRoot: ghqGithubRoot,
      rows: [
        { label: "~", tokenName: "home-main", method: "named" },
        { label: "acme/matched-repo", tokenName: "matcher", method: "matched" },
        { label: "acme/unknown-repo", tokenName: "unknown", method: "unmatched" },
      ],
    });

    const rendered = formatScan(scan);
    expect(rendered).toContain("3 oracles using 3 tokens");
    expect(rendered).toContain("1. home-main (1 repos)");
    expect(rendered).toContain("2. matcher (1 repos)");
    expect(rendered).toContain("3. unknown (1 repos)");
    expect(rendered).toContain("acme/unknown-repo *");
    expect(rendered).toContain("* = token not in pass vault (unknown)");
  });

  test("formatScan handles error and empty result states", () => {
    expect(formatScan({ ok: false, rows: [], ghqRoot: null, error: "broken" })).toBe("scan: broken");
    expect(formatScan({ ok: true, rows: [], ghqRoot: ghqGithubRoot })).toBe(
      "No .envrc files with Claude tokens found",
    );
  });
});
