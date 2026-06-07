import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const root = join(import.meta.dir, "../..");

let appliedPlans: unknown[] = [];
let cloneTargets: string[] = [];
let cleanupTargets: string[] = [];
let fleetRegistrations: unknown[] = [];
let prs: unknown[] = [];
let seeded: unknown[] = [];
let peerCopies: unknown[] = [];
let failSeed = false;
let failPeers = false;
let failFleet = false;

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-exec"), () => ({
  applyFromRepoInjection: async (plan: unknown, opts: unknown) => {
    appliedPlans.push({ plan, opts });
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-git"), () => ({
  cloneShallow: async (target: string) => {
    cloneTargets.push(target);
    const tmp = mkdtempSync(join(tmpdir(), "maw-bud-from-repo-clone-"));
    mkdirSync(join(tmp, ".git"));
    return tmp;
  },
  cleanupClone: (target: string) => {
    cleanupTargets.push(target);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  },
  branchCommitPushPR: async (target: string, stem: string, log: (message: string) => void) => {
    prs.push({ target, stem });
    log(`branching ${stem}`);
    return `https://github.com/example/${stem}/pull/1`;
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-fleet"), () => ({
  registerFleetEntry: (opts: unknown) => {
    fleetRegistrations.push(opts);
    if (failFleet) throw new Error("fleet offline");
    return { created: fleetRegistrations.length === 1, file: "/fleet/01-bud.json" };
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-seed"), () => ({
  seedFromParent: (target: string, parent: string, log: (message: string) => void) => {
    seeded.push({ target, parent });
    if (failSeed) throw new Error("seed missing");
    log(`seeded ${parent}`);
  },
  copyPeersSnapshot: (target: string, log: (message: string) => void) => {
    peerCopies.push({ target });
    if (failPeers) throw new Error("peers missing");
    log("copied peers");
  },
}));

const {
  cmdBudFromRepo,
  formatPlan,
  looksLikeUrl,
  planFromRepoInjection,
} = await import("../../src/vendor/mpr-plugins/bud/from-repo");

let tempRoot = "";
let logs: string[] = [];
const originalLog = console.log;

function makeRepo(name = "target") {
  const repo = join(tempRoot, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

function baseOpts(target: string, overrides: Record<string, unknown> = {}) {
  return {
    target,
    stem: "newbud",
    isUrl: false,
    pr: false,
    dryRun: false,
    ...overrides,
  } as any;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-bud-from-repo-"));
  appliedPlans = [];
  cloneTargets = [];
  cleanupTargets = [];
  fleetRegistrations = [];
  prs = [];
  seeded = [];
  peerCopies = [];
  failSeed = false;
  failPeers = false;
  failFleet = false;
  logs = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("bud from-repo coverage", () => {
  test("classifies URLs and org/repo slugs without treating local paths as URLs", () => {
    expect(looksLikeUrl("https://github.com/org/repo")).toBe(true);
    expect(looksLikeUrl("http://github.com/org/repo")).toBe(true);
    expect(looksLikeUrl("git@github.com:org/repo.git")).toBe(true);
    expect(looksLikeUrl("org/repo")).toBe(true);
    expect(looksLikeUrl("./org/repo")).toBe(false);
    expect(looksLikeUrl("/tmp/org/repo")).toBe(false);
    expect(looksLikeUrl("org/repo/extra")).toBe(false);
  });

  test("plans blockers for URL dry-runs, missing paths, files, non-git repos, and existing vaults", () => {
    expect(planFromRepoInjection(baseOpts("org/repo", { isUrl: true, dryRun: true })).blockers[0]).toContain("clone would be a side effect");
    expect(planFromRepoInjection(baseOpts(join(tempRoot, "missing"))).blockers[0]).toContain("target path does not exist");

    const fileTarget = join(tempRoot, "file.txt");
    writeFileSync(fileTarget, "not a dir");
    expect(planFromRepoInjection(baseOpts(fileTarget)).blockers[0]).toContain("target is not a directory");

    const notGit = join(tempRoot, "not-git");
    mkdirSync(notGit);
    expect(planFromRepoInjection(baseOpts(notGit)).blockers[0]).toContain("no .git");

    const withPsi = makeRepo("with-psi");
    mkdirSync(join(withPsi, "ψ"));
    expect(planFromRepoInjection(baseOpts(withPsi)).blockers[0]).toContain("ψ/ already present");
  });

  test("plans force merges, existing files, tracked vaults, seed, sync-peers, and lineage fleet reasons", () => {
    const repo = makeRepo("repo");
    mkdirSync(join(repo, "ψ"));
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, "CLAUDE.md"), "existing");
    writeFileSync(join(repo, ".claude", "settings.local.json"), "{}");

    const plan = planFromRepoInjection(baseOpts(repo, {
      force: true,
      from: "parent",
      trackVault: true,
      seed: true,
      syncPeers: true,
    }));

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "append", path: "CLAUDE.md" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "skip", path: ".claude/settings.local.json" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "skip", path: ".gitignore", reason: expect.stringContaining("--track-vault") }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "write", path: "ψ/memory/ (seeded from parent)" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "write", path: "ψ/peers.json" }));
    expect(plan.actions.find(a => a.path === "fleet/<NN>-newbud.json")?.reason).toContain("budded_from=parent");
    expect(plan.actions.filter(a => a.kind === "mkdir")).toHaveLength(8);

    const rendered = formatPlan(plan);
    expect(rendered).toContain("Oracle scaffold plan");
    expect(rendered).toContain("append");
    expect(rendered).toContain("skip");
  });

  test("plans and applies seed-without-parent as a non-blocking skip", async () => {
    const repo = makeRepo("seedless");

    const plan = planFromRepoInjection(baseOpts(repo, { seed: true }));
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual({
      kind: "skip",
      path: "ψ/memory/ (seed)",
      reason: "--seed requires --from <parent> — nothing to seed from",
    });

    await cmdBudFromRepo(baseOpts(repo, { seed: true }));

    expect(appliedPlans).toHaveLength(1);
    expect(seeded).toEqual([]);
    expect(logs.join("\n")).toContain("--seed ignored (no --from <parent> to seed from)");
  });

  test("local execution refuses blocker plans before applying writes", async () => {
    const missing = join(tempRoot, "missing");

    await expect(cmdBudFromRepo(baseOpts(missing))).rejects.toThrow("plan has 1 blocker(s) — see above");

    expect(appliedPlans).toEqual([]);
    expect(logs.join("\n")).toContain("target path does not exist");
  });

  test("dry-run local plans without applying writes and URL dry-runs refuse side effects", async () => {
    const repo = makeRepo("dry");
    await cmdBudFromRepo(baseOpts(repo, { dryRun: true }));
    expect(logs.join("\n")).toContain("Oracle scaffold plan");
    expect(appliedPlans).toEqual([]);
    expect(fleetRegistrations).toEqual([]);

    await expect(cmdBudFromRepo(baseOpts("org/repo", { isUrl: true, dryRun: true }))).rejects.toThrow("plan has 1 blocker");
    expect(cloneTargets).toEqual([]);
  });

  test("local execution applies injection, logs recoverable seed peer and fleet failures, and opens PRs", async () => {
    const repo = makeRepo("local");
    failSeed = true;
    failPeers = true;
    failFleet = true;

    await cmdBudFromRepo(baseOpts(repo, {
      from: "parent",
      seed: true,
      syncPeers: true,
      pr: true,
    }));

    expect(appliedPlans).toHaveLength(1);
    expect(seeded).toEqual([{ target: repo, parent: "parent" }]);
    expect(peerCopies).toEqual([{ target: repo }]);
    expect(fleetRegistrations).toEqual([{ stem: "newbud", target: repo, parent: "parent" }]);
    expect(prs).toEqual([{ target: repo, stem: "newbud" }]);
    const rendered = logs.join("\n");
    expect(rendered).toContain("--seed failed: seed missing");
    expect(rendered).toContain("--sync-peers failed: peers missing");
    expect(rendered).toContain("fleet entry skipped: fleet offline");
    expect(rendered).toContain("PR opened");
  });

  test("URL execution clones, forces PR mode for the local clone, and always cleans up", async () => {
    await cmdBudFromRepo(baseOpts("Soul-Brews-Studio/target", { isUrl: true, pr: false }));

    expect(cloneTargets).toEqual(["Soul-Brews-Studio/target"]);
    expect(appliedPlans).toHaveLength(1);
    expect((appliedPlans[0] as any).opts.pr).toBe(true);
    expect(prs).toEqual([{ target: cleanupTargets[0], stem: "newbud" }]);
    expect(cleanupTargets).toHaveLength(1);
    expect(existsSync(cleanupTargets[0]!)).toBe(false);
    expect(logs.join("\n")).toContain("cleaned up temp clone");
  });
});
