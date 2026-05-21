import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const root = join(import.meta.dir, "../..");
const fleetDir = mkdtempSync(join(tmpdir(), "maw-bud-wake-fleet-"));
const ghqRoot = mkdtempSync(join(tmpdir(), "maw-bud-wake-ghq-"));

let hostExecCalls: string[] = [];
let soulSyncCalls: Array<{ parent: string; opts: Record<string, unknown> }> = [];
let wakeCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
let fleetEntries: Array<{ session: { name: string }; file: string }> = [];
let issuePromptCalls: Array<{ issue: number; repo: string }> = [];
let ensureClonedCalls: string[] = [];
let splitCalls: string[] = [];
let syncDirCalls: Array<{ src: string; dst: string }> = [];
let shouldAutoWakeCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
let logs: string[] = [];
let failSoulSync = false;
let failHostExec = false;
let failWake = false;
let wakeDecision = { wake: true, reason: "bud policy" };

const originalLog = console.log;
const originalTmux = process.env.TMUX;

mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (failHostExec) throw new Error("git offline");
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleetEntries: () => fleetEntries,
}));

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (name: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ name, opts });
    if (failWake) throw new Error("tmux refused");
  },
  fetchIssuePrompt: async (issue: number, repo: string) => {
    issuePromptCalls.push({ issue, repo });
    return `issue ${issue} from ${repo}`;
  },
}));

mock.module("maw-js/commands/shared/should-auto-wake", () => ({
  shouldAutoWake: (name: string, opts: Record<string, unknown>) => {
    shouldAutoWakeCalls.push({ name, opts });
    return wakeDecision;
  },
}));

mock.module("maw-js/commands/shared/wake-target", () => ({
  ensureCloned: async (repo: string) => {
    ensureClonedCalls.push(repo);
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/internal/soul-sync-impl"), () => ({
  cmdSoulSync: async (parent: string, opts: Record<string, unknown>) => {
    soulSyncCalls.push({ parent, opts });
    if (failSoulSync) throw new Error("empty psi");
  },
  syncDir: (src: string, dst: string) => {
    syncDirCalls.push({ src, dst });
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/split/impl"), () => ({
  cmdSplit: async (name: string) => {
    splitCalls.push(name);
  },
}));

const {
  applyFromRepoInjection,
  oracleMarkerBegin,
  oracleMarkerEnd,
} = await import("../../src/vendor/mpr-plugins/bud/from-repo-exec.ts?bud-from-repo-exec-coverage");
const { finalizeBud } = await import("../../src/vendor/mpr-plugins/bud/bud-wake.ts?bud-from-repo-exec-coverage");

let tempRoot = "";

function makeRepo(name: string): string {
  const repo = join(tempRoot, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

function plan(target: string, blockers: string[] = []) {
  return { target, blockers, actions: [] } as any;
}

function finalizeCtx(overrides: Partial<Parameters<typeof finalizeBud>[0]> = {}) {
  const budRepoPath = join(tempRoot, "bud-repo");
  const psiDir = join(budRepoPath, "ψ");
  mkdirSync(psiDir, { recursive: true });
  return {
    name: "sprout",
    parentName: "parent",
    org: "Soul-Brews-Studio",
    budRepoName: "child-repo",
    budRepoPath,
    psiDir,
    fleetFile: join(fleetDir, "01-sprout.json"),
    opts: {},
    ...overrides,
  } as Parameters<typeof finalizeBud>[0];
}

function resetDir(path: string) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-bud-from-repo-exec-"));
  resetDir(fleetDir);
  resetDir(ghqRoot);
  hostExecCalls = [];
  soulSyncCalls = [];
  wakeCalls = [];
  fleetEntries = [];
  issuePromptCalls = [];
  ensureClonedCalls = [];
  splitCalls = [];
  syncDirCalls = [];
  shouldAutoWakeCalls = [];
  logs = [];
  failSoulSync = false;
  failHostExec = false;
  failWake = false;
  wakeDecision = { wake: true, reason: "bud policy" };
  delete process.env.TMUX;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(fleetDir, { recursive: true, force: true });
  rmSync(ghqRoot, { recursive: true, force: true });
});

describe("bud from-repo exec", () => {
  test("refuses blocker plans before mutating the target", async () => {
    const repo = makeRepo("blocked");

    await expect(applyFromRepoInjection(plan(repo, ["ψ/ already present"]), { stem: "seed" } as any)).rejects.toThrow(
      "cannot apply — plan has 1 blocker(s): ψ/ already present",
    );

    expect(existsSync(join(repo, "ψ"))).toBe(false);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });

  test("writes a fresh oracle scaffold with lineage and ignored vault", async () => {
    const repo = makeRepo("fresh");
    const logLines: string[] = [];

    await applyFromRepoInjection(plan(repo), { stem: "sprout", from: "parent" } as any, (line) => logLines.push(line));

    for (const sub of ["learnings", "retrospectives", "traces", "resonance", "collaborations"]) {
      expect(existsSync(join(repo, "ψ", "memory", sub))).toBe(true);
    }
    for (const sub of ["inbox", "outbox", "plans"]) {
      expect(existsSync(join(repo, "ψ", sub))).toBe(true);
    }
    expect(readFileSync(join(repo, ".claude", "settings.local.json"), "utf-8")).toBe("{}\n");
    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("# sprout-oracle");
    expect(claude).toContain("Budded from **parent**");
    expect(claude).toContain("<!-- oracle-lineage: parent=parent -->");
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).toBe("ψ/\n");
    expect(logLines.join("\n")).toContain("ψ/ vault initialized (8 dirs)");
    expect(logLines.join("\n")).toContain("run `maw wake sprout`");
  });

  test("writes a fresh root scaffold without lineage and can leave the vault tracked", async () => {
    const repo = makeRepo("root-scaffold");
    const logLines: string[] = [];

    await applyFromRepoInjection(plan(repo), { stem: "rooty", trackVault: true } as any, (line) => logLines.push(line));

    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("# rooty-oracle");
    expect(claude).toContain("Oracle scaffolding injected on");
    expect(claude).toContain("- **Origin**: injected into existing repo (not budded from a parent)");
    expect(claude).not.toContain("oracle-lineage");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(logLines.join("\n")).toContain("CLAUDE.md written (full template)");
  });

  test("appends to existing files idempotently and respects tracked or already-ignored vaults", async () => {
    const repo = makeRepo("existing");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), "{\"kept\":true}\n");
    writeFileSync(join(repo, "CLAUDE.md"), "# Existing\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules\nψ\n");
    const firstLogs: string[] = [];

    await applyFromRepoInjection(plan(repo), { stem: "sprout" } as any, (line) => firstLogs.push(line));
    await applyFromRepoInjection(plan(repo), { stem: "sprout", trackVault: true } as any, (line) => firstLogs.push(line));

    expect(readFileSync(join(repo, ".claude", "settings.local.json"), "utf-8")).toBe("{\"kept\":true}\n");
    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claude.match(new RegExp(oracleMarkerBegin("sprout"), "g")) ?? []).toHaveLength(1);
    expect(claude).toContain(oracleMarkerEnd("sprout"));
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).toBe("node_modules\nψ\n");
    const rendered = firstLogs.join("\n");
    expect(rendered).toContain(".claude/settings.local.json exists — untouched");
    expect(rendered).toContain("CLAUDE.md already has oracle block for stem=sprout — skip");
    expect(rendered).toContain(".gitignore already ignores ψ/ — skip");
  });
});

describe("bud wake finalization", () => {
  test("seeds, commits, updates parent peers, wakes with issue/repo opts, splits, and copies project psi", async () => {
    process.env.TMUX = "/tmp/tmux.sock,1,2";
    const parentFleetFile = join(fleetDir, "01-parent.json");
    writeFileSync(parentFleetFile, JSON.stringify({ sync_peers: ["existing"] }));
    fleetEntries = [{ session: { name: "01-parent" }, file: "01-parent.json" }];
    const localMemory = join(ghqRoot, "github.com", "owner/project", "ψ", "memory");
    mkdirSync(join(localMemory, "learnings"), { recursive: true });
    mkdirSync(join(localMemory, "traces"), { recursive: true });

    const ctx = finalizeCtx({ opts: { seed: true, issue: 42, repo: "owner/project", split: true } });
    await finalizeBud(ctx);

    expect(soulSyncCalls).toEqual([{ parent: "parent", opts: { from: true, cwd: ctx.budRepoPath } }]);
    expect(hostExecCalls).toEqual([
      `git -C '${ctx.budRepoPath}' add -A`,
      `git -C '${ctx.budRepoPath}' commit -m 'feat: birth — budded from parent'`,
      `git -C '${ctx.budRepoPath}' push -u origin HEAD`,
    ]);
    expect(JSON.parse(readFileSync(parentFleetFile, "utf-8")).sync_peers).toEqual(["existing", "sprout"]);
    expect(shouldAutoWakeCalls).toEqual([{ name: "sprout", opts: { site: "bud" } }]);
    expect(issuePromptCalls).toEqual([{ issue: 42, repo: "Soul-Brews-Studio/child-repo" }]);
    expect(ensureClonedCalls).toEqual(["owner/project"]);
    expect(wakeCalls).toEqual([
      {
        name: "sprout",
        opts: {
          noAttach: true,
          repoPath: ctx.budRepoPath,
          prompt: "issue 42 from Soul-Brews-Studio/child-repo",
          task: "issue-42",
        },
      },
    ]);
    expect(splitCalls).toEqual(["sprout"]);
    expect(syncDirCalls).toEqual([
      { src: join(localMemory, "learnings"), dst: join(ctx.psiDir, "memory", "learnings") },
      { src: join(localMemory, "traces"), dst: join(ctx.psiDir, "memory", "traces") },
    ]);
    const rendered = logs.join("\n");
    expect(rendered).toContain("initial commit pushed");
    expect(rendered).toContain("added sprout to parent's sync_peers");
    expect(rendered).toContain("copied local project ψ/ from owner/project");
  });

  test("logs recoverable failures, root/no-tmux paths, and wake policy skips", async () => {
    failSoulSync = true;
    failHostExec = true;
    failWake = true;
    await finalizeBud(finalizeCtx({ opts: { seed: true, split: true } }));

    let rendered = logs.join("\n");
    expect(rendered).toContain("soul-sync seed failed");
    expect(rendered).toContain("git push failed");
    expect(rendered).toContain("wake failed: tmux refused");
    expect(rendered).toContain("--split requires tmux session");

    logs = [];
    wakeDecision = { wake: false, reason: "policy disabled" };
    await finalizeBud(finalizeCtx({ parentName: null, opts: {} }));

    rendered = logs.join("\n");
    expect(rendered).toContain("root oracle — no parent");
    expect(rendered).toContain("root oracle — no parent sync_peers to update");
    expect(rendered).toContain("wake skipped: policy disabled");
  });
});
