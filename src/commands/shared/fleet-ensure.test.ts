import { describe, it, expect } from "bun:test";
import { _test, ensureFleetSessionEntry } from "./fleet-ensure";

const { repoFromCwd } = _test;

describe("repoFromCwd", () => {
  const ghqRoot = "/opt/Code";

  it("extracts org/repo from a normal github repo path", () => {
    expect(repoFromCwd("/opt/Code/github.com/Soul-Brews-Studio/maw-js", ghqRoot))
      .toBe("github.com/Soul-Brews-Studio/maw-js");
  });

  it("extracts org/repo from github.com candidate (2-segment)", () => {
    expect(repoFromCwd("/opt/Code/github.com/acme/repo", ghqRoot))
      .toBe("github.com/acme/repo");
  });

  it("strips worktree suffix under agents/", () => {
    expect(repoFromCwd("/opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/1-codex-issue", ghqRoot))
      .toBe("github.com/Soul-Brews-Studio/maw-js");
  });

  it("strips deep worktree paths", () => {
    expect(repoFromCwd("/opt/Code/github.com/acme/repo/agents/3-codex-perf/src/lib", ghqRoot))
      .toBe("github.com/acme/repo");
  });


  it("rejects archive copies under the ghq root", () => {
    const result = _test.repoFromCwdResult(
      "/opt/Code/_archive/oracle-world/nat-2026-06-10/ghq/github.com/acme/repo",
      ghqRoot,
    );
    expect(result).toMatchObject({
      repo: null,
      archiveCopy: true,
      reason: expect.stringContaining("refusing to register archive copy"),
    });
    expect(repoFromCwd("/opt/Code/_archive/oracle-world/nat-2026-06-10/ghq/github.com/acme/repo", ghqRoot)).toBeNull();
  });

  it("returns null for paths outside ghq root", () => {
    expect(repoFromCwd("/home/user/projects/foo", ghqRoot)).toBeNull();
  });

  it("returns null for undefined cwd", () => {
    expect(repoFromCwd(undefined, ghqRoot)).toBeNull();
  });

  it("returns null for too-shallow paths", () => {
    expect(repoFromCwd("/opt/Code/github.com", ghqRoot)).toBeNull();
    expect(repoFromCwd("/opt/Code/github.com/acme", ghqRoot)).toBeNull();
  });
});

describe("ensureFleetSessionEntry worktree repo", () => {
  it("stores parent repo, not worktree path, in fleet window", () => {
    let written = "";
    const result = ensureFleetSessionEntry(
      { session: "test-wt", window: "codex-issue", cwd: "/opt/Code/github.com/acme/repo/agents/1-codex-issue", createdBy: "maw wake" },
      {
        fleetDirsForRead: () => ["/tmp/fleet-test-empty"],
        loadFleetEntries: () => [],
        getGhqRoot: () => "/opt/Code",
        existsSync: () => false,
        mkdirSync: () => undefined,
        writeFileSync: (_p: any, data: any) => { written = data; },
        fleetDirForWrite: () => "/tmp/fleet-test",
        now: () => new Date("2026-01-01"),
      },
    );
    expect(result.status).toBe("created");
    const parsed = JSON.parse(written);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.windows[0].repo).toBe("github.com/acme/repo");
  });
});
