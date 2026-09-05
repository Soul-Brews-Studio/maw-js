/**
 * Isolated coverage for src/vendor/mpr-plugins/done/done-worktree.ts.
 *
 * The module imports the SDK transport and fleet directory at module load time,
 * so keep this file isolated and mock those seams before importing it.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-done-worktree-"));
const FLEET_DIR = join(SANDBOX, "fleet");
const REPOS_ROOT = join(SANDBOX, "repos");

type HostExecHandler = (command: string) => string | Promise<string>;

let hostExecCalls: string[] = [];
let hostExecHandler: HostExecHandler = () => "";
let fleetReadDirs: string[] = [FLEET_DIR];

mock.module("maw-js/sdk", () => ({
  FLEET_DIR,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    return await hostExecHandler(command);
  },
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirsForRead: () => fleetReadDirs,
}));

const {
  cleanupDoneBranch,
  removeFromFleetConfig,
  removeWorktreeByGhqScan,
  removeWorktreeViaConfig,
} = await import("../../src/vendor/mpr-plugins/done/done-worktree.ts?done-worktree-coverage");

function resetSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(FLEET_DIR, { recursive: true });
  mkdirSync(REPOS_ROOT, { recursive: true });
}

function writeFleetConfig(file: string, payload: unknown) {
  writeFileSync(join(FLEET_DIR, file), JSON.stringify(payload, null, 2));
}

function readFleetConfig(file: string) {
  return JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
}

async function captureConsole(fn: () => Promise<unknown> | unknown) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  const capture = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  resetSandbox();
  hostExecCalls = [];
  hostExecHandler = () => "";
  fleetReadDirs = [FLEET_DIR];
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("cleanupDoneBranch", () => {
  test("deletes ancestor branches against the maw-js alpha base", async () => {
    const mainPath = join(REPOS_ROOT, "Soul-Brews-Studio", "maw-js");

    const output = await captureConsole(async () => {
      await cleanupDoneBranch(mainPath, "feature/merged");
    });

    expect(hostExecCalls).toEqual([
      `git -C '${mainPath}' merge-base --is-ancestor 'feature/merged' 'alpha'`,
      `git -C '${mainPath}' branch -d 'feature/merged'`,
    ]);
    expect(output).toContain("deleted branch feature/merged (merged into alpha)");
  });

  test("uses merged PR proof for squash-merged branches", async () => {
    const mainPath = join(REPOS_ROOT, "Soul-Brews-Studio", "maw-js");
    hostExecHandler = (command) => {
      if (command.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
      if (command.startsWith("gh pr list")) return "[{\"number\":1922}]";
      return "";
    };

    const output = await captureConsole(async () => {
      await cleanupDoneBranch(mainPath, "agents/1922-clean-branch");
    });

    expect(hostExecCalls).toEqual([
      `git -C '${mainPath}' merge-base --is-ancestor 'agents/1922-clean-branch' 'alpha'`,
      "gh pr list --head 'agents/1922-clean-branch' --state merged --json number --limit 1",
      `git -C '${mainPath}' branch -D 'agents/1922-clean-branch'`,
    ]);
    expect(output).toContain("deleted branch agents/1922-clean-branch (merged PR)");
  });

  test("keeps branches when gh proof is unavailable or no merged PR exists", async () => {
    const mainPath = join(REPOS_ROOT, "Soul-Brews-Studio", "maw-js");
    hostExecHandler = (command) => {
      if (command.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
      if (command.startsWith("gh pr list")) throw new Error("gh missing");
      return "";
    };

    let output = await captureConsole(async () => {
      await cleanupDoneBranch(mainPath, "feature/unverified");
    });
    expect(output).toContain("branch retained (feature/unverified): gh unavailable and not merged into alpha");
    expect(hostExecCalls).not.toContain(`git -C '${mainPath}' branch -D 'feature/unverified'`);

    hostExecCalls = [];
    hostExecHandler = (command) => {
      if (command.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
      if (command.startsWith("gh pr list")) return "[]";
      return "";
    };
    output = await captureConsole(async () => {
      await cleanupDoneBranch(mainPath, "feature/open");
    });
    expect(output).toContain("branch retained (feature/open): not merged into alpha and no merged PR found");
    expect(hostExecCalls).not.toContain(`git -C '${mainPath}' branch -D 'feature/open'`);
  });

  test("--clean-branch force-deletes without proof and generic repos use main", async () => {
    const genericPath = join(REPOS_ROOT, "acme", "tool");

    const output = await captureConsole(async () => {
      await cleanupDoneBranch(genericPath, "feature/force", { cleanBranch: true });
    });

    expect(hostExecCalls).toEqual([`git -C '${genericPath}' branch -D 'feature/force'`]);
    expect(output).toContain("force-deleted branch feature/force");

    hostExecCalls = [];
    await captureConsole(async () => {
      await cleanupDoneBranch(genericPath, "feature/default");
    });
    expect(hostExecCalls[0]).toBe(`git -C '${genericPath}' merge-base --is-ancestor 'feature/default' 'main'`);
  });
});

describe("removeWorktreeViaConfig", () => {
  test("removes a configured worktree and deletes its non-main branch", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "FeaturePane", repo: "Soul-Brews-Studio/maw-js.wt-123-feature" }],
    });

    hostExecHandler = (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/done-cleanup\n";
      return "";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeViaConfig("featurepane", REPOS_ROOT)).toBe(true);
    });

    const fullPath = join(REPOS_ROOT, "Soul-Brews-Studio/maw-js.wt-123-feature");
    const mainPath = join(REPOS_ROOT, "Soul-Brews-Studio", "maw-js");
    expect(hostExecCalls).toEqual([
      `git -C '${fullPath}' rev-parse --abbrev-ref HEAD`,
      `git -C '${mainPath}' worktree remove '${fullPath}'`,
      `git -C '${mainPath}' worktree prune`,
      `git -C '${mainPath}' merge-base --is-ancestor 'feature/done-cleanup' 'alpha'`,
      `git -C '${mainPath}' branch -d 'feature/done-cleanup'`,
    ]);
    expect(output).toContain("removed worktree Soul-Brews-Studio/maw-js.wt-123-feature");
    expect(output).toContain("deleted branch feature/done-cleanup (merged into alpha)");
  });

  test("uses state fleet configs before duplicate legacy configs", async () => {
    const stateFleetDir = join(SANDBOX, "state-fleet");
    mkdirSync(stateFleetDir, { recursive: true });
    fleetReadDirs = [stateFleetDir, FLEET_DIR];
    writeFileSync(
      join(stateFleetDir, "oracle.json"),
      JSON.stringify({ windows: [{ name: "FeaturePane", repo: "StateOrg/state-repo.wt-feature" }] }),
      "utf-8",
    );
    writeFleetConfig("oracle.json", {
      windows: [{ name: "FeaturePane", repo: "LegacyOrg/legacy-repo.wt-feature" }],
    });

    hostExecHandler = (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "main\n";
      return "";
    };

    expect(await removeWorktreeViaConfig("featurepane", REPOS_ROOT)).toBe(true);

    expect(hostExecCalls).toContain(
      `git -C '${join(REPOS_ROOT, "StateOrg/state-repo.wt-feature")}' rev-parse --abbrev-ref HEAD`,
    );
    expect(hostExecCalls.join("\n")).not.toContain("LegacyOrg/legacy-repo");
  });

  test("returns false after reporting a worktree removal failure", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "stuck", repo: "org/repo.wt-stuck" }],
    });
    hostExecHandler = (command) => {
      if (command.includes("worktree remove")) throw new Error("busy worktree");
      return "main\n";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeViaConfig("stuck", REPOS_ROOT)).toBe(false);
    });

    expect(hostExecCalls.some(command => command.includes("worktree remove"))).toBe(true);
    expect(output).toContain("worktree remove failed: busy worktree");
  });

  test("fails loud instead of force-removing dirty configured worktrees without --force", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "dirty", repo: "org/repo.wt-dirty" }],
    });
    hostExecHandler = (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/dirty\n";
      if (command.includes("worktree remove")) throw new Error("fatal: contains modified or untracked files");
      return "";
    };

    await expect(captureConsole(async () => {
      await removeWorktreeViaConfig("dirty", REPOS_ROOT);
    })).rejects.toThrow("has uncommitted changes; rerun maw done --force");

    expect(hostExecCalls.some(command => command.includes("worktree remove") && command.includes("--force"))).toBe(false);
  });

  test("ignores configured non-worktree repos", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "plain", repo: "org/repo" }],
    });

    expect(await removeWorktreeViaConfig("plain", REPOS_ROOT)).toBe(false);
    expect(hostExecCalls).toEqual([]);
  });
});

describe("removeWorktreeByGhqScan", () => {
  test("removes only exact suffix matches from ghq scan results", async () => {
    const exact = join(REPOS_ROOT, "github.com", "org", "repo.wt-123-feature");
    const substringOnly = join(REPOS_ROOT, "github.com", "org", "repo.wt-feature-extra");
    const other = join(REPOS_ROOT, "github.com", "org", "other.wt-bugfix");

    hostExecHandler = (command) => {
      if (command.startsWith(`find '${REPOS_ROOT}'`)) {
        return [exact, substringOnly, other].join("\n");
      }
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/done\n";
      if (command.includes("merge-base --is-ancestor")) throw new Error("not merged");
      if (command.startsWith("gh pr list")) return "[]";
      return "";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mother-feature", REPOS_ROOT)).toBe(true);
    });

    const mainPath = exact.replace("repo.wt-123-feature", "repo");
    expect(hostExecCalls).toEqual([
      `find '${REPOS_ROOT}' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`,
      `git -C '${exact}' rev-parse --abbrev-ref HEAD`,
      `git -C '${mainPath}' worktree remove '${exact}'`,
      `git -C '${mainPath}' worktree prune`,
      `git -C '${mainPath}' merge-base --is-ancestor 'feature/done' 'main'`,
      "gh pr list --head 'feature/done' --state merged --json number --limit 1",
    ]);
    expect(output).toContain("removed worktree repo.wt-123-feature");
    expect(output).toContain("branch retained (feature/done): not merged into main and no merged PR found");
    expect(output).not.toContain("repo.wt-feature-extra");
  });


  test("refuses ambiguous exact suffix matches without mutating worktrees", async () => {
    const one = join(REPOS_ROOT, "github.com", "org", "repo.wt-feature");
    const two = join(REPOS_ROOT, "github.com", "other", "repo.wt-feature");

    hostExecHandler = (command) => {
      if (command.startsWith(`find '${REPOS_ROOT}'`)) return [one, two].join("\n");
      throw new Error(`unexpected mutation: ${command}`);
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mother-feature", REPOS_ROOT)).toBe(false);
    });

    expect(hostExecCalls).toEqual([`find '${REPOS_ROOT}' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`]);
    expect(output).toContain("refusing to remove worktree 'feature' — matches 2 repos");
    expect(output).toContain(one);
    expect(output).toContain(two);
    expect(output).toContain("use fleet config or remove the exact worktree manually");
  });


  test("uses caller cwd to disambiguate exact suffix matches and dry-run avoids worktree removal", async () => {
    const one = join(REPOS_ROOT, "github.com", "laris-co", "ccc-oracle.wt-trio-coder");
    const two = join(REPOS_ROOT, "github.com", "Soul-Brews-Studio", "mawjs-oracle", "agents", "1-trio-coder");
    hostExecHandler = (command) => {
      if (command.startsWith(`find '${REPOS_ROOT}'`)) return [one, two].join("\n");
      if (command.includes("rev-parse --show-toplevel")) return `${join(REPOS_ROOT, "github.com", "Soul-Brews-Studio", "mawjs-oracle", "agents", "1-trio-coder")}\n`;
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/trio\n";
      return "";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mawjs-trio-coder", REPOS_ROOT, {}, { cwd: join(REPOS_ROOT, "github.com", "Soul-Brews-Studio", "mawjs-oracle") })).toBe(true);
    });

    expect(output).toContain("scoped ambiguous worktree 'trio-coder'");
    expect(hostExecCalls).toContain(`git -C '${join(REPOS_ROOT, "github.com", "Soul-Brews-Studio", "mawjs-oracle")}' worktree remove '${two}'`);
    expect(hostExecCalls.join("\n")).not.toContain("ccc-oracle.wt-trio-coder' --force");

    hostExecCalls = [];
    hostExecHandler = (command) => {
      if (command.startsWith(`find '${REPOS_ROOT}'`)) return two;
      throw new Error(`dry-run should not mutate: ${command}`);
    };
    const dryRunOutput = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mawjs-trio-coder", REPOS_ROOT, {}, { dryRun: true })).toBe(true);
    });
    expect(hostExecCalls).toEqual([`find '${REPOS_ROOT}' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`]);
    expect(dryRunOutput).toContain("[dry-run] would remove worktree agents/1-trio-coder");
  });

  test("reports scan failures and returns false", async () => {
    hostExecHandler = () => {
      throw new Error("find denied");
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mother-feature", REPOS_ROOT)).toBe(false);
    });

    expect(hostExecCalls).toHaveLength(1);
    expect(output).toContain("worktree scan failed: Error: find denied");
  });
});

describe("removeFromFleetConfig", () => {
  test("removes matching windows from all fleet json files", () => {
    writeFleetConfig("one.json", {
      windows: [
        { name: "Keep", repo: "org/keep" },
        { name: "DonePane", repo: "org/repo.wt-done" },
      ],
    });
    writeFleetConfig("two.json", {
      windows: [{ name: "donepane", repo: "org/other.wt-done" }],
    });
    writeFileSync(join(FLEET_DIR, "ignored.txt"), "not json");

    const output = captureConsole(() => {
      expect(removeFromFleetConfig("donepane")).toBe(true);
    });

    expect(readFleetConfig("one.json").windows).toEqual([{ name: "Keep", repo: "org/keep" }]);
    expect(readFleetConfig("two.json").windows).toEqual([]);
    return expect(output).resolves.toContain("removed from one.json");
  });

  test("removes matching windows from state before duplicate legacy configs", () => {
    const stateFleetDir = join(SANDBOX, "state-fleet-remove");
    mkdirSync(stateFleetDir, { recursive: true });
    fleetReadDirs = [stateFleetDir, FLEET_DIR];
    writeFileSync(
      join(stateFleetDir, "one.json"),
      JSON.stringify({
        windows: [
          { name: "DonePane", repo: "state/repo.wt-done" },
          { name: "Keep", repo: "state/repo" },
        ],
      }),
      "utf-8",
    );
    writeFleetConfig("one.json", {
      windows: [{ name: "DonePane", repo: "legacy/repo.wt-done" }],
    });

    expect(removeFromFleetConfig("donepane")).toBe(true);

    expect(JSON.parse(readFileSync(join(stateFleetDir, "one.json"), "utf-8")).windows).toEqual([
      { name: "Keep", repo: "state/repo" },
    ]);
    expect(readFleetConfig("one.json").windows).toEqual([
      { name: "DonePane", repo: "legacy/repo.wt-done" },
    ]);
  });

  test("returns false when no fleet config contains the window", () => {
    writeFleetConfig("one.json", { windows: [{ name: "Other", repo: "org/repo" }] });

    expect(removeFromFleetConfig("missing")).toBe(false);
    expect(readFleetConfig("one.json").windows).toEqual([{ name: "Other", repo: "org/repo" }]);
  });
});
