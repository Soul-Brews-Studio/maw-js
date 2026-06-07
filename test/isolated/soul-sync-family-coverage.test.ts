import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type FleetSession = {
  name: string;
  windows: Array<{ repo: string }>;
  sync_peers?: string[];
  project_repos?: string[];
};

type Subject = {
  cmdSoulSync: (target?: string, opts?: { from?: boolean; cwd?: string }) => Promise<Array<{ from: string; to: string; total: number; synced: Record<string, number> }>>;
  cmdSoulSyncProject: (opts?: { cwd?: string }) => Promise<Array<{ project: string; oracle: string; total: number; synced: Record<string, number> }>>;
  findProjectsForOracle: (oracleName: string) => string[];
};

let tempRoot = "";
let ghqRoot = "";
let reposRoot = "";
let currentPanePath = "";
let fleet: FleetSession[] = [];
let ghqFindCalls: string[] = [];
let hostExecCalls: string[] = [];
let logs: string[] = [];
let ghqFindMisses: Set<string> = new Set();
let gitCommonDirByCwd: Map<string, string | Error> = new Map();
let gitTopLevelByCwd: Map<string, string | Error> = new Map();

const originalLog = console.log;

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => fleet,
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async (query: string) => {
    ghqFindCalls.push(query);
    const match = query.match(/^\/(.+)-oracle\$$/);
    if (!match) return "";
    const stem = match[1]!;
    if (ghqFindMisses.has(stem)) return "";
    const candidate = join(reposRoot, "Org", `${stem}-oracle`);
    return existsSync(candidate) ? candidate : "";
  },
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (cmd.includes("tmux display-message")) {
      if (currentPanePath === "__throw__") throw new Error("tmux unavailable");
      return `${currentPanePath}\n`;
    }

    const commonDirMatch = cmd.match(/^git -C '(.+)' rev-parse --git-common-dir$/);
    if (commonDirMatch) {
      const value = gitCommonDirByCwd.get(commonDirMatch[1]!);
      if (value instanceof Error) throw value;
      if (value !== undefined) return `${value}\n`;
      throw new Error("not a git worktree");
    }

    const topLevelMatch = cmd.match(/^git -C '(.+)' rev-parse --show-toplevel$/);
    if (topLevelMatch) {
      const value = gitTopLevelByCwd.get(topLevelMatch[1]!);
      if (value instanceof Error) throw value;
      if (value !== undefined) return `${value}\n`;
      throw new Error("not a git repo");
    }

    return "";
  },
}));

const subjects: Array<{ name: string; mod: Subject }> = [
  { name: "archive internal", mod: await import("../../src/vendor/mpr-plugins/archive/internal/soul-sync-impl") },
  { name: "bud internal", mod: await import("../../src/vendor/mpr-plugins/bud/internal/soul-sync-impl") },
  { name: "done internal", mod: await import("../../src/vendor/mpr-plugins/done/internal/soul-sync-impl") },
  { name: "soul-sync plugin", mod: await import("../../src/vendor/mpr-plugins/soul-sync/impl") },
];

function safeStem(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function repoPath(repo: string) {
  return join(reposRoot, "Org", repo);
}

function makeRepo(repo: string) {
  const path = repoPath(repo);
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
}

function writeVaultFile(repo: string, rel: string, body = rel) {
  const path = join(repo, "ψ", rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function readVaultFile(repo: string, rel: string) {
  return readFileSync(join(repo, "ψ", rel), "utf-8");
}

function seedFixture(label: string) {
  const stem = safeStem(label);
  const alpha = `${stem}-alpha`;
  const beta = `${stem}-beta`;
  const ghost = `${stem}-ghost`;
  const lonely = `${stem}-lonely`;
  const owner = `${stem}-owner`;
  const missingOwner = `${stem}-missing-owner`;

  const alphaPath = makeRepo(`${alpha}-oracle`);
  const betaPath = makeRepo(`${beta}-oracle`);
  const lonelyPath = makeRepo(`${lonely}-oracle`);
  const ownerPath = makeRepo(`${owner}-oracle`);
  const projectInPath = makeRepo(`${stem}-project-in`);
  const projectExportPath = makeRepo(`${stem}-project-export`);
  const unownedProjectPath = makeRepo(`${stem}-unowned-project`);
  const orphanProjectPath = makeRepo(`${stem}-orphan-project`);
  const alphaWorktree = join(reposRoot, "Org", `${alpha}-oracle.wt-feature`);
  const projectSubdir = join(projectExportPath, "packages", "pkg");
  const outsidePath = join(tempRoot, "outside", `${stem}-external-project`);

  mkdirSync(alphaWorktree, { recursive: true });
  mkdirSync(projectSubdir, { recursive: true });
  mkdirSync(outsidePath, { recursive: true });

  writeVaultFile(alphaPath, "memory/learnings/alpha.md", `${label} learning`);
  writeVaultFile(alphaPath, "memory/traces/nested/trace.md", `${label} trace`);
  writeVaultFile(projectInPath, "memory/retrospectives/retro.md", `${label} project retro`);
  writeVaultFile(projectExportPath, "memory/collaborations/collab.md", `${label} project collab`);

  fleet = [
    {
      name: `01-${alpha}`,
      windows: [{ repo: `Org/${alpha}-oracle` }],
      sync_peers: [beta, ghost],
      project_repos: [`Org/${stem}-project-in`, `Org/${stem}-missing-project`],
    },
    { name: `02-${beta}`, windows: [{ repo: `Org/${beta}-oracle` }] },
    { name: `03-${lonely}`, windows: [{ repo: `Org/${lonely}-oracle` }] },
    {
      name: `04-${owner}`,
      windows: [{ repo: `Org/${owner}-oracle` }],
      project_repos: [`Org/${stem}-project-export`],
    },
    {
      name: `05-${missingOwner}`,
      windows: [{ repo: `Org/${missingOwner}-oracle` }],
      project_repos: [`Org/${stem}-orphan-project`],
    },
  ];

  ghqFindMisses.add(beta);
  currentPanePath = alphaWorktree;
  gitCommonDirByCwd.set(alphaWorktree, join(alphaPath, ".git"));
  gitCommonDirByCwd.set(betaPath, ".git");
  gitCommonDirByCwd.set(lonelyPath, "relative-main/.git");
  gitTopLevelByCwd.set(projectSubdir, projectExportPath);

  return {
    alpha,
    beta,
    ghost,
    lonely,
    alphaPath,
    betaPath,
    lonelyPath,
    ownerPath,
    projectInPath,
    projectExportPath,
    unownedProjectPath,
    orphanProjectPath,
    projectSubdir,
    outsidePath,
    stem,
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-soul-sync-family-"));
  ghqRoot = join(tempRoot, "ghq");
  reposRoot = join(ghqRoot, "github.com");
  mkdirSync(reposRoot, { recursive: true });
  currentPanePath = "";
  fleet = [];
  ghqFindCalls = [];
  hostExecCalls = [];
  logs = [];
  ghqFindMisses = new Set();
  gitCommonDirByCwd = new Map();
  gitTopLevelByCwd = new Map();
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("soul-sync family isolated coverage", () => {
  for (const { name, mod } of subjects) {
    test(`${name} covers peer sync and project sync branches`, async () => {
      const fx = seedFixture(name);

      const pushed = await mod.cmdSoulSync();
      expect(pushed).toEqual([
        {
          from: fx.alpha,
          to: fx.beta,
          synced: {
            "memory/learnings": 1,
            "memory/traces": 1,
          },
          total: 2,
        },
      ]);
      expect(readVaultFile(fx.betaPath, "memory/learnings/alpha.md")).toBe(`${name} learning`);
      expect(readVaultFile(fx.betaPath, "memory/traces/nested/trace.md")).toBe(`${name} trace`);
      expect(readFileSync(join(fx.betaPath, "ψ/.soul-sync/sync.log"), "utf-8")).toContain(`${fx.alpha} → ${fx.beta} | 2 files`);
      expect(logs.join("\n")).toContain(`${fx.ghost}: repo not found, skipping`);
      expect(ghqFindCalls).toContain(`/${fx.beta}-oracle$`);
      expect(hostExecCalls).toContain("tmux display-message -p '#{pane_current_path}'");
      expect(hostExecCalls).toContain(`git -C '${join(reposRoot, "Org", `${fx.alpha}-oracle.wt-feature`)}' rev-parse --git-common-dir`);

      const pulledNoop = await mod.cmdSoulSync(fx.alpha, { from: true, cwd: fx.betaPath });
      expect(pulledNoop).toEqual([{ from: fx.alpha, to: fx.beta, synced: {}, total: 0 }]);
      expect(logs.join("\n")).toContain(`${fx.alpha} → ${fx.beta}: nothing new`);

      const noPeer = await mod.cmdSoulSync(undefined, { cwd: fx.lonelyPath });
      expect(noPeer).toEqual([]);
      expect(logs.join("\n")).toContain(`no sync_peers configured for '${fx.lonely}'`);

      currentPanePath = "__throw__";
      const soulSyncFallbackCwd = await mod.cmdSoulSync();
      expect(soulSyncFallbackCwd).toEqual([]);
      expect(logs.join("\n")).toContain(`no sync_peers configured for '${process.cwd().split("/").pop()}'`);

      const absorbed = await mod.cmdSoulSyncProject({ cwd: fx.alphaPath });
      expect(absorbed).toEqual([
        {
          project: `Org/${fx.stem}-project-in`,
          oracle: fx.alpha,
          synced: { "memory/retrospectives": 1 },
          total: 1,
        },
      ]);
      expect(readVaultFile(fx.alphaPath, "memory/retrospectives/retro.md")).toBe(`${name} project retro`);
      expect(logs.join("\n")).toContain(`Org/${fx.stem}-missing-project: not found`);

      const noProjects = await mod.cmdSoulSyncProject({ cwd: fx.lonelyPath });
      expect(noProjects).toEqual([]);
      expect(logs.join("\n")).toContain(`no project_repos configured for '${fx.lonely}'`);
      expect(mod.findProjectsForOracle(`${fx.stem}-not-in-fleet`)).toEqual([]);

      const badSlug = await mod.cmdSoulSyncProject({ cwd: fx.outsidePath });
      expect(badSlug).toEqual([]);
      expect(logs.join("\n")).toContain("cannot resolve project slug");

      const unowned = await mod.cmdSoulSyncProject({ cwd: fx.unownedProjectPath });
      expect(unowned).toEqual([]);
      expect(logs.join("\n")).toContain(`no oracle owns project 'Org/${fx.stem}-unowned-project'`);

      const missingOracle = await mod.cmdSoulSyncProject({ cwd: fx.orphanProjectPath });
      expect(missingOracle).toEqual([]);
      expect(logs.join("\n")).toContain(`oracle '${fx.stem}-missing-owner' repo not found locally`);

      currentPanePath = fx.projectSubdir;
      const exported = await mod.cmdSoulSyncProject();
      expect(exported).toEqual([
        {
          project: `Org/${fx.stem}-project-export`,
          oracle: `${fx.stem}-owner`,
          synced: { "memory/collaborations": 1 },
          total: 1,
        },
      ]);
      expect(readVaultFile(fx.ownerPath, "memory/collaborations/collab.md")).toBe(`${name} project collab`);
      expect(readFileSync(join(fx.ownerPath, "ψ/.soul-sync/sync.log"), "utf-8")).toContain(`project:Org/${fx.stem}-project-export → ${fx.stem}-owner | 1 files`);

      currentPanePath = "__throw__";
      const fallbackCwd = await mod.cmdSoulSyncProject();
      expect(fallbackCwd).toEqual([]);
      expect(logs.join("\n")).toContain("not under repos root");
    });
  }
});
