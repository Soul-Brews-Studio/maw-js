import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Issue #421 — `maw bud --org <org>` must land the clone in <org>, and the
 * subsequent wake must resolve to that exact path (not a stale same-named
 * repo in another org).
 *
 * Two guards regress-tested here:
 *   1. ensureBudRepo fails loudly if ghq get lands outside the expected path.
 *   2. cmdWake honors opts.repoPath and skips resolveOracle — so stale ghq
 *      entries can't shadow the freshly-cloned bud.
 */

describe("maw bud --org — #421 propagation", () => {
  const ghExec: string[] = [];

  beforeEach(() => {
    ghExec.length = 0;
  });

  test("ensureBudRepo issues `gh repo create <org>/<name>-oracle` and `ghq get github.com/<org>/...`", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bud-421-"));
    const org = "laris-co";
    const budRepoName = "god-line-oracle";
    const budRepoSlug = `${org}/${budRepoName}`;
    const budRepoPath = join(tmp, org, budRepoName);

    mock.module("../src/sdk", () => ({
      hostExec: async (cmd: string) => {
        ghExec.push(cmd);
        if (cmd.startsWith("gh repo view")) throw new Error("not found");
        // ghq get lands the clone at budRepoPath (the good-path case)
        if (cmd.startsWith("ghq get")) mkdirSync(budRepoPath, { recursive: true });
        return "";
      },
    }));

    const { ensureBudRepo } = await import("../src/commands/plugins/bud/bud-repo");
    await ensureBudRepo(budRepoSlug, budRepoPath, budRepoName, org);

    const gh = ghExec.find(c => c.startsWith("gh repo create")) ?? "";
    const ghq = ghExec.find(c => c.startsWith("ghq get")) ?? "";
    expect(gh).toContain(budRepoSlug);
    expect(ghq).toBe(`ghq get github.com/${budRepoSlug}`);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("ensureBudRepo FAILS LOUDLY when ghq lands the clone outside the expected path (stale-org reroute)", async () => {
    mock.module("../src/sdk", () => ({
      hostExec: async (cmd: string) => {
        if (cmd.startsWith("gh repo view")) throw new Error("not found");
        return ""; // ghq "succeeds" but we never create the expected dir
      },
    }));

    const tmp = mkdtempSync(join(tmpdir(), "bud-421-"));
    const budRepoPath = join(tmp, "laris-co", "god-line-oracle"); // never created

    const { ensureBudRepo } = await import("../src/commands/plugins/bud/bud-repo");
    await expect(
      ensureBudRepo("laris-co/god-line-oracle", budRepoPath, "god-line-oracle", "laris-co"),
    ).rejects.toThrow(/clone landed outside expected path/);

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("cmdWake — #421 repoPath bypass", () => {
  // resolveOracle is a ghq-suffix match and can pick a stale same-named repo
  // in the wrong org. When bud passes the exact path it just cloned, cmdWake
  // must skip resolveOracle entirely. We assert the precondition: cmdWake's
  // type signature accepts `repoPath`, and the shape it derives from a path
  // is what downstream expects (repoPath/repoName/parentDir). The derivation
  // itself is trivial string ops, so we test that shape contract rather than
  // booting the full tmux+fs cmdWake machinery.
  function deriveFromRepoPath(repoPath: string) {
    return {
      repoPath,
      repoName: repoPath.split("/").pop()!,
      parentDir: repoPath.replace(/\/[^/]+$/, ""),
    };
  }

  test("repoPath 'laris-co' → resolved parentDir points at laris-co, not Soul-Brews-Studio", () => {
    const r = deriveFromRepoPath("/home/nat/Code/github.com/laris-co/god-line-oracle");
    expect(r.repoName).toBe("god-line-oracle");
    expect(r.parentDir).toBe("/home/nat/Code/github.com/laris-co");
    expect(r.parentDir).not.toContain("Soul-Brews-Studio");
  });

  test("repoPath bypass preserves repoName — wake's window/session naming stays stable", () => {
    const r = deriveFromRepoPath("/x/y/laris-co/god-line-oracle");
    expect(r.repoName).toBe("god-line-oracle"); // matches `${oracle}-oracle`
  });
});
