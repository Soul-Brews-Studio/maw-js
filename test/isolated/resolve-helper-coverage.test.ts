import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type ResolveSubject = {
  resolveOraclePath: (name: string) => Promise<string | null>;
  resolveProjectSlug: (repoRoot: string, ghqRoot: string) => string | null;
  findOracleForProject: (projectRepo: string) => string | null;
};

let tempRoot = "";
let ghqRoot = "";
let ghqResult = "";
let ghqCalls: string[] = [];
let fleet: Array<{
  name: string;
  windows: Array<{ repo: string }>;
  project_repos?: string[];
}> = [];

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async (query: string) => {
    ghqCalls.push(query);
    return ghqResult;
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => fleet,
}));

const subjects: Array<{ name: string; mod: ResolveSubject }> = [
  { name: "archive", mod: await import("../../src/vendor/mpr-plugins/archive/internal/resolve") },
  { name: "bud", mod: await import("../../src/vendor/mpr-plugins/bud/internal/resolve") },
  { name: "done", mod: await import("../../src/vendor/mpr-plugins/done/internal/resolve") },
  { name: "soul-sync", mod: await import("../../src/vendor/mpr-plugins/soul-sync/resolve") },
];

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-resolve-helper-"));
  ghqRoot = join(tempRoot, "ghq");
  ghqResult = "";
  ghqCalls = [];
  fleet = [];
  mkdirSync(ghqRoot, { recursive: true });
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("archive/bud/done/soul-sync resolve helpers", () => {
  for (const { name, mod } of subjects) {
    test(`${name} resolves direct ghq hits, fleet fallbacks, and missing oracle repos`, async () => {
      ghqResult = "/direct/neo-oracle";
      await expect(mod.resolveOraclePath("neo-oracle")).resolves.toBe("/direct/neo-oracle");
      expect(ghqCalls.at(-1)).toBe("/neo-oracle$");

      ghqResult = "";
      const fallbackRepo = join(ghqRoot, "github.com", "Org", "fallback-oracle");
      mkdirSync(fallbackRepo, { recursive: true });
      fleet = [{ name: "07-fallback", windows: [{ repo: "Org/fallback-oracle" }] }];
      await expect(mod.resolveOraclePath("fallback")).resolves.toBe(fallbackRepo);

      fleet = [{ name: "08-missing", windows: [{ repo: "Org/missing-oracle" }] }];
      await expect(mod.resolveOraclePath("missing")).resolves.toBeNull();
    });

    test(`${name} normalizes project slugs for ghq roots, agents worktrees, and invalid paths`, () => {
      expect(mod.resolveProjectSlug(
        join(ghqRoot, "github.com", "Org", "project", "agents", "feature-a"),
        ghqRoot,
      )).toBe("Org/project");
      expect(mod.resolveProjectSlug(
        join(ghqRoot, "github.com", "Org", "project.wt-feature"),
        ghqRoot,
      )).toBe("Org/project");
      expect(mod.resolveProjectSlug(join(ghqRoot, "github.com", "Org"), ghqRoot)).toBeNull();
      expect(mod.resolveProjectSlug(join(tempRoot, "outside", "Org", "project"), ghqRoot)).toBeNull();
    });

    test(`${name} finds project owners from fleet project_repos`, () => {
      fleet = [
        { name: "04-owner", windows: [], project_repos: ["Org/project"] },
        { name: "05-other", windows: [], project_repos: ["Org/other"] },
      ];

      expect(mod.findOracleForProject("Org/project")).toBe("owner");
      expect(mod.findOracleForProject("Org/missing")).toBeNull();
    });
  }
});
