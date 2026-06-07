import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "../..");
let applied: unknown[] = [];
let cleanupTargets: string[] = [];
let registerCreated = false;
let cloneShouldFailAfterLocal = false;
const logs: string[] = [];
const originalLog = console.log;
let tempRoot = "";

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-exec"), () => ({
  applyFromRepoInjection: async (plan: unknown, opts: unknown) => {
    applied.push({ plan, opts });
    if (cloneShouldFailAfterLocal) throw new Error("apply failed after clone");
  },
}));
mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-git"), () => ({
  cloneShallow: async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-bud-clone-failure-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  },
  cleanupClone: (target: string) => {
    cleanupTargets.push(target);
    rmSync(target, { recursive: true, force: true });
  },
  branchCommitPushPR: async () => "https://example.invalid/pr/1",
}));
mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-fleet"), () => ({
  registerFleetEntry: () => ({ created: registerCreated, file: "/fleet/newbud.json" }),
}));
mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-seed"), () => ({
  seedFromParent: () => undefined,
  copyPeersSnapshot: () => undefined,
}));

const { cmdBudFromRepo, formatPlan, looksLikeUrl, planFromRepoInjection } = await import("../../src/vendor/mpr-plugins/bud/from-repo.ts?coverage-100-vendor-a-bud");

function makeRepo(name: string) {
  const repo = join(tempRoot, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-bud-from-repo-a-"));
  applied = [];
  cleanupTargets = [];
  registerCreated = false;
  cloneShouldFailAfterLocal = false;
  logs.length = 0;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("coverage-100 vendor-a bud from-repo gaps", () => {
  test("plans absent files and updated fleet entries without optional seed or peers", async () => {
    expect(looksLikeUrl("git@github.com:org/repo.git")).toBe(true);
    expect(looksLikeUrl("relative/path/extra")).toBe(false);

    const repo = makeRepo("plain");
    const plan = planFromRepoInjection({ target: repo, stem: "newbud", isUrl: false, pr: false, dryRun: false } as any);
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "write", path: "CLAUDE.md" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "write", path: ".claude/settings.local.json" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "append", path: ".gitignore" }));
    expect(formatPlan(plan)).toContain("write");

    await cmdBudFromRepo({ target: repo, stem: "newbud", isUrl: false, pr: false, dryRun: false } as any);
    expect(applied).toHaveLength(1);
    expect(logs.join("\n")).toContain("fleet entry updated: /fleet/newbud.json");
  });

  test("URL clone cleanup runs even when delegated local injection fails", async () => {
    cloneShouldFailAfterLocal = true;
    await expect(cmdBudFromRepo({ target: "org/repo", stem: "newbud", isUrl: true, pr: false, dryRun: false } as any)).rejects.toThrow("apply failed after clone");
    expect(cleanupTargets).toHaveLength(1);
    expect(existsSync(cleanupTargets[0]!)).toBe(false);
    expect(logs.join("\n")).toContain("cleaned up temp clone");
  });
});
