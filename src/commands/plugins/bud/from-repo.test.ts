import { describe, it, expect, mock, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InvokeContext } from "../../../plugin/types";
import { planFromRepoInjection, looksLikeUrl, cmdBudFromRepo } from "./from-repo";
import { applyFromRepoInjection, oracleMarkerBegin } from "./from-repo-exec";

// Hermetic default: stub the fleet module so the test suite never writes to
// the real ~/.config/maw/fleet/. Individual describe blocks override as needed.
const fleetCalls: { stem: string; target: string; parent?: string }[] = [];
mock.module("./from-repo-fleet", () => ({
  registerFleetEntry: (opts: { stem: string; target: string; parent?: string }) => {
    fleetCalls.push(opts);
    return { file: `/tmp/fake-fleet/${opts.stem}.json`, created: true, slug: { org: "fake", repo: "fake" } };
  },
  parseRemoteUrl: (_: string) => null,
  resolveSlug: (_: string) => ({ org: "fake", repo: "fake" }),
  readOriginRemote: (_: string) => null,
}));

function mkGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-from-repo-test-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

describe("from-repo: looksLikeUrl", () => {
  it("https URL", () => expect(looksLikeUrl("https://github.com/x/y")).toBe(true));
  it("git@ URL", () => expect(looksLikeUrl("git@github.com:x/y.git")).toBe(true));
  it("org/repo slug", () => expect(looksLikeUrl("Soul-Brews-Studio/maw-js")).toBe(true));
  it("absolute path", () => expect(looksLikeUrl("/home/nat/code/repo")).toBe(false));
  it("relative path", () => expect(looksLikeUrl("./repo")).toBe(false));
});

describe("from-repo: planFromRepoInjection", () => {
  it("plans a clean local repo (no CLAUDE.md, no ψ/)", () => {
    const dir = mkGitRepo();
    try {
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
      });
      expect(plan.blockers).toEqual([]);
      const kinds = plan.actions.map(a => `${a.kind}:${a.path}`);
      expect(kinds).toContain("mkdir:ψ/memory/learnings");
      expect(kinds).toContain("mkdir:ψ/inbox");
      expect(kinds).toContain("write:CLAUDE.md");
      expect(kinds).toContain("write:.claude/settings.local.json");
      expect(kinds).toContain("append:.gitignore");
      expect(kinds.some(k => k.startsWith("write:fleet/"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends (not overwrites) when CLAUDE.md already exists", () => {
    const dir = mkGitRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# existing\n");
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
      });
      const claude = plan.actions.find(a => a.path === "CLAUDE.md");
      expect(claude?.kind).toBe("append");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when ψ/ already present", () => {
    const dir = mkGitRepo();
    try {
      mkdirSync(join(dir, "ψ"));
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
      });
      expect(plan.blockers.length).toBeGreaterThan(0);
      expect(plan.blockers[0]).toContain("ψ/ already present");
      expect(plan.actions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when target is not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-nongit-"));
    try {
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
      });
      expect(plan.blockers.some(b => b.includes("not a git repo"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when target path does not exist", () => {
    const plan = planFromRepoInjection({
      target: "/nonexistent/path/for-maw-test",
      stem: "demo", isUrl: false, pr: false, dryRun: true,
    });
    expect(plan.blockers.some(b => b.includes("does not exist"))).toBe(true);
  });

  it("blocks URL dry-run (clone is a side-effect)", () => {
    const plan = planFromRepoInjection({
      target: "https://github.com/x/y", stem: "demo", isUrl: true, pr: false, dryRun: true,
    });
    expect(plan.blockers.some(b => b.includes("dry-run"))).toBe(true);
  });
});

describe("from-repo: cmdBudFromRepo", () => {
  it("dry-run on clean repo completes without throwing", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({ target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run on blocked target throws with blocker count", async () => {
    const dir = mkGitRepo();
    mkdirSync(join(dir, "ψ"));
    try {
      await expect(cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
      })).rejects.toThrow(/blocker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-dry-run on clean repo writes ψ/, CLAUDE.md, .claude/settings.local.json", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({ target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false });
      expect(statSync(join(dir, "ψ", "inbox")).isDirectory()).toBe(true);
      expect(statSync(join(dir, "ψ", "memory", "learnings")).isDirectory()).toBe(true);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain("demo-oracle");
      expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf-8")).toBe("{}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-dry-run refuses on collision (existing ψ/) without partial write", async () => {
    const dir = mkGitRepo();
    mkdirSync(join(dir, "ψ"));
    try {
      await expect(cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false,
      })).rejects.toThrow(/blocker/);
      // CLAUDE.md not touched
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("from-repo: applyFromRepoInjection (executor)", () => {
  it("appends under marker when CLAUDE.md exists and preserves original content", async () => {
    const dir = mkGitRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# host project\n\nPre-existing host content.\n");
      const plan = planFromRepoInjection({ target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false });
      await applyFromRepoInjection(plan, { target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false }, () => {});
      const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# host project");
      expect(content).toContain("Pre-existing host content.");
      expect(content).toContain(oracleMarkerBegin("demo"));
      expect(content).toContain("Oracle scaffolding");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotent re-run — second apply does not re-append CLAUDE.md", async () => {
    const dir = mkGitRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# host\n");
      const opts = { target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false };
      const plan = planFromRepoInjection(opts);
      await applyFromRepoInjection(plan, opts, () => {});
      const firstContent = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      // Re-plan: ψ/ now exists, so planner would block — but executor alone should be idempotent on CLAUDE.md
      const replan = { ...plan, blockers: [] }; // simulate a re-apply path (stem match → skip)
      await applyFromRepoInjection(replan, opts, () => {});
      const secondContent = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(secondContent).toBe(firstContent);
      // Count markers — exactly one
      const markerCount = (secondContent.match(new RegExp(oracleMarkerBegin("demo").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      expect(markerCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing .claude/settings.local.json", async () => {
    const dir = mkGitRepo();
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "settings.local.json"), `{"keep":true}\n`);
      const opts = { target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false };
      const plan = planFromRepoInjection(opts);
      await applyFromRepoInjection(plan, opts, () => {});
      expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf-8")).toBe(`{"keep":true}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when invoked with a blocker'd plan", async () => {
    const opts = { target: "/nonexistent/zzz", stem: "demo", isUrl: false, pr: false, dryRun: false };
    const plan = planFromRepoInjection(opts);
    await expect(applyFromRepoInjection(plan, opts, () => {})).rejects.toThrow(/blocker/);
  });
});

describe("from-repo: URL-mode + --pr (mocked git/gh)", () => {
  let cmdBudFromRepoMocked: typeof cmdBudFromRepo;
  let calls: { fn: string; args: any[] }[] = [];

  beforeEach(async () => {
    calls = [];
    mock.module("./from-repo-git", () => ({
      scaffoldBranchName: (stem: string) => `oracle/scaffold-${stem}`,
      cloneShallow: async (url: string) => {
        calls.push({ fn: "cloneShallow", args: [url] });
        const d = mkGitRepo();
        return d;
      },
      cleanupClone: (dir: string) => {
        calls.push({ fn: "cleanupClone", args: [dir] });
        rmSync(dir, { recursive: true, force: true });
      },
      branchCommitPushPR: async (cwd: string, stem: string, _log: any) => {
        calls.push({ fn: "branchCommitPushPR", args: [cwd, stem] });
        return `https://github.com/fake/pr/1`;
      },
    }));
    delete (require.cache as any)[require.resolve("./from-repo")];
    const mod = await import("./from-repo");
    cmdBudFromRepoMocked = mod.cmdBudFromRepo;
  });

  it("URL target: clones, injects, opens PR, cleans up", async () => {
    await cmdBudFromRepoMocked({
      target: "https://github.com/fake/repo", stem: "demo",
      isUrl: true, pr: false, dryRun: false,
    });
    const fns = calls.map(c => c.fn);
    expect(fns).toContain("cloneShallow");
    expect(fns).toContain("branchCommitPushPR");
    expect(fns).toContain("cleanupClone");
    // order: clone must precede PR, which must precede cleanup
    expect(fns.indexOf("cloneShallow")).toBeLessThan(fns.indexOf("branchCommitPushPR"));
    expect(fns.indexOf("branchCommitPushPR")).toBeLessThan(fns.indexOf("cleanupClone"));
    // PR passed the stem, not the URL
    const prCall = calls.find(c => c.fn === "branchCommitPushPR")!;
    expect(prCall.args[1]).toBe("demo");
  });

  it("URL target dry-run throws without cloning", async () => {
    await expect(cmdBudFromRepoMocked({
      target: "https://github.com/fake/repo", stem: "demo",
      isUrl: true, pr: false, dryRun: true,
    })).rejects.toThrow(/blocker/);
    expect(calls.some(c => c.fn === "cloneShallow")).toBe(false);
  });

  it("URL target cleans up even when PR fails", async () => {
    // Re-mock: branchCommitPushPR throws
    mock.module("./from-repo-git", () => ({
      scaffoldBranchName: (stem: string) => `oracle/scaffold-${stem}`,
      cloneShallow: async (url: string) => {
        calls.push({ fn: "cloneShallow", args: [url] });
        return mkGitRepo();
      },
      cleanupClone: (dir: string) => {
        calls.push({ fn: "cleanupClone", args: [dir] });
        rmSync(dir, { recursive: true, force: true });
      },
      branchCommitPushPR: async () => {
        calls.push({ fn: "branchCommitPushPR", args: [] });
        throw new Error("gh pr create failed");
      },
    }));
    delete (require.cache as any)[require.resolve("./from-repo")];
    const mod = await import("./from-repo");
    await expect(mod.cmdBudFromRepo({
      target: "https://github.com/fake/repo", stem: "demo",
      isUrl: true, pr: false, dryRun: false,
    })).rejects.toThrow(/gh pr create failed/);
    expect(calls.some(c => c.fn === "cleanupClone")).toBe(true);
  });

  it("local path + --pr: injects then opens PR without cloning", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepoMocked({
        target: dir, stem: "demo", isUrl: false, pr: true, dryRun: false,
      });
      const fns = calls.map(c => c.fn);
      expect(fns).not.toContain("cloneShallow");
      expect(fns).not.toContain("cleanupClone");
      expect(fns).toContain("branchCommitPushPR");
      // Injection actually happened
      expect(existsSync(join(dir, "ψ", "inbox"))).toBe(true);
      // PR was opened against the local path, not a tmpdir
      const prCall = calls.find(c => c.fn === "branchCommitPushPR")!;
      expect(prCall.args[0]).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local path without --pr: no PR helper called", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepoMocked({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false,
      });
      expect(calls.some(c => c.fn === "branchCommitPushPR")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local + --pr: PR failure does NOT swallow the error", async () => {
    mock.module("./from-repo-git", () => ({
      scaffoldBranchName: (stem: string) => `oracle/scaffold-${stem}`,
      cloneShallow: async () => { throw new Error("should not clone"); },
      cleanupClone: () => {},
      branchCommitPushPR: async () => { throw new Error("push rejected"); },
    }));
    delete (require.cache as any)[require.resolve("./from-repo")];
    const mod = await import("./from-repo");
    const dir = mkGitRepo();
    try {
      await expect(mod.cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: true, dryRun: false,
      })).rejects.toThrow(/push rejected/);
      // injection happened before PR attempt — ψ/ present
      expect(existsSync(join(dir, "ψ", "inbox"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("from-repo: handler wiring", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;

  beforeEach(async () => {
    mock.module("./impl", () => ({
      cmdBud: async (name: string) => { console.log(`budding ${name}`); },
    }));
    // re-import to pick up mock
    delete (require.cache as any)[require.resolve("./index")];
    const mod = await import("./index");
    handler = mod.default;
  });

  it("--from-repo without --stem returns error", async () => {
    const result = await handler({ source: "cli", args: ["--from-repo", "/tmp/x"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--stem");
  });

  it("--stem ending with -oracle rejected", async () => {
    const result = await handler({
      source: "cli",
      args: ["--from-repo", "/tmp/x", "--stem", "foo-oracle"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("-oracle");
  });

  it("--from-repo --dry-run on clean local repo succeeds", async () => {
    const dir = mkGitRepo();
    try {
      const result = await handler({
        source: "cli",
        args: ["--from-repo", dir, "--stem", "demo", "--dry-run"],
      });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("from-repo: --force / --from / --track-vault (#588 continuation)", () => {
  it("--force lifts the ψ/ collision blocker", () => {
    const dir = mkGitRepo();
    try {
      mkdirSync(join(dir, "ψ"));
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true, force: true,
      });
      expect(plan.blockers).toEqual([]);
      expect(plan.actions.find(a => a.path === "ψ/memory/learnings")?.kind).toBe("mkdir");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without --force the ψ/ collision blocker mentions --force as a remedy", () => {
    const dir = mkGitRepo();
    try {
      mkdirSync(join(dir, "ψ"));
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
      });
      expect(plan.blockers[0]).toContain("--force");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--from <parent> embeds lineage marker in CLAUDE.md (full-write path)", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false, from: "neo",
      });
      const claude = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("Budded from");
      expect(claude).toContain("neo");
      expect(claude).toContain("<!-- oracle-lineage: parent=neo -->");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--from <parent> embeds lineage marker in CLAUDE.md (append path)", async () => {
    const dir = mkGitRepo();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# host\n");
      await cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false, from: "neo",
      });
      const claude = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("# host");
      expect(claude).toContain("Budded from");
      expect(claude).toContain("<!-- oracle-lineage: parent=neo -->");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default appends `ψ/` to .gitignore (creates file if absent)", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({ target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false });
      const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
      expect(gi).toContain("ψ/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--track-vault skips the .gitignore write", async () => {
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false, trackVault: true,
      });
      expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".gitignore append is idempotent", async () => {
    const dir = mkGitRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "node_modules/\nψ/\n");
      await cmdBudFromRepo({ target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false });
      const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
      expect(gi.match(/ψ\//g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan reflects --track-vault as skip:.gitignore", () => {
    const dir = mkGitRepo();
    try {
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true, trackVault: true,
      });
      const gi = plan.actions.find(a => a.path === ".gitignore");
      expect(gi?.kind).toBe("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan reflects --seed + --sync-peers when set", () => {
    const dir = mkGitRepo();
    try {
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
        from: "parent", seed: true, syncPeers: true,
      });
      const kinds = plan.actions.map(a => `${a.kind}:${a.path}`);
      expect(kinds.some(k => k.includes("ψ/memory/ (seeded from parent)"))).toBe(true);
      expect(kinds).toContain("write:ψ/peers.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan shows --seed without --from as a skip", () => {
    const dir = mkGitRepo();
    try {
      const plan = planFromRepoInjection({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: true,
        seed: true,
      });
      const seedAction = plan.actions.find(a => a.path === "ψ/memory/ (seed)");
      expect(seedAction?.kind).toBe("skip");
      expect(seedAction?.reason).toContain("--from");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orchestrator wires registerFleetEntry with stem/target/parent", async () => {
    const before = fleetCalls.length;
    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({
        target: dir, stem: "lineage-test", isUrl: false, pr: false, dryRun: false, from: "neo",
      });
      const newCalls = fleetCalls.slice(before);
      expect(newCalls.length).toBe(1);
      expect(newCalls[0].stem).toBe("lineage-test");
      expect(newCalls[0].target).toBe(dir);
      expect(newCalls[0].parent).toBe("neo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("from-repo: --seed + --sync-peers (file-copy pair)", () => {
  let prevPeersFile: string | undefined;

  beforeEach(() => {
    prevPeersFile = process.env.PEERS_FILE;
  });

  // --seed mocks the config barrel so parent tree resolves inside a tmp ghq root.
  // Post #680 the bud code calls getGhqRoot() + "github.com", so the mock
  // exports both loadConfig (for githubOrg) and a fake getGhqRoot, and fixtures
  // live at <ghqRoot>/github.com/<org>/...
  async function installConfigMock(ghqRoot: string) {
    mock.module("../../../config", () => ({
      loadConfig: () => ({ githubOrg: "Fake-Org" }),
    }));
    // #680 — getGhqRoot moved to leaf module config/ghq-root.
    mock.module("../../../config/ghq-root", () => ({
      getGhqRoot: () => ghqRoot,
    }));
    delete (require.cache as any)[require.resolve("./from-repo-seed")];
    delete (require.cache as any)[require.resolve("./from-repo")];
    return await import("./from-repo");
  }

  it("--seed copies parent's ψ/memory/ into target", async () => {
    const ghqRoot = mkdtempSync(join(tmpdir(), "maw-ghq-"));
    const parentMem = join(ghqRoot, "github.com", "Fake-Org", "parent-oracle", "ψ", "memory");
    mkdirSync(join(parentMem, "learnings"), { recursive: true });
    writeFileSync(join(parentMem, "learnings", "a.md"), "hello from parent\n");
    writeFileSync(join(parentMem, "root.txt"), "root memory\n");

    const dir = mkGitRepo();
    try {
      const mod = await installConfigMock(ghqRoot);
      await mod.cmdBudFromRepo({
        target: dir, stem: "child", isUrl: false, pr: false, dryRun: false,
        from: "parent", seed: true,
      });
      expect(readFileSync(join(dir, "ψ", "memory", "learnings", "a.md"), "utf-8")).toBe("hello from parent\n");
      expect(readFileSync(join(dir, "ψ", "memory", "root.txt"), "utf-8")).toBe("root memory\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghqRoot, { recursive: true, force: true });
    }
  });

  it("--seed is dest-biased: pre-existing target file is NOT overwritten", async () => {
    const ghqRoot = mkdtempSync(join(tmpdir(), "maw-ghq-"));
    const parentMem = join(ghqRoot, "github.com", "Fake-Org", "parent-oracle", "ψ", "memory");
    mkdirSync(join(parentMem, "learnings"), { recursive: true });
    writeFileSync(join(parentMem, "learnings", "collide.md"), "parent wins\n");

    const dir = mkGitRepo();
    try {
      // Pre-seed the child with conflicting content (simulate prior work)
      mkdirSync(join(dir, "ψ", "memory", "learnings"), { recursive: true });
      writeFileSync(join(dir, "ψ", "memory", "learnings", "collide.md"), "child keeps\n");

      const mod = await installConfigMock(ghqRoot);
      await mod.cmdBudFromRepo({
        target: dir, stem: "child", isUrl: false, pr: false, dryRun: false,
        from: "parent", seed: true, force: true,
      });
      // Child's pre-existing file wins
      expect(readFileSync(join(dir, "ψ", "memory", "learnings", "collide.md"), "utf-8")).toBe("child keeps\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghqRoot, { recursive: true, force: true });
    }
  });

  it("--seed without --from is a no-op (no parent to seed)", async () => {
    const ghqRoot = mkdtempSync(join(tmpdir(), "maw-ghq-"));
    const dir = mkGitRepo();
    try {
      const mod = await installConfigMock(ghqRoot);
      await mod.cmdBudFromRepo({
        target: dir, stem: "child", isUrl: false, pr: false, dryRun: false,
        seed: true, // no from
      });
      // Vault exists (from normal injection) but empty — no parent memory to copy
      expect(existsSync(join(dir, "ψ", "memory"))).toBe(true);
      // Spot-check: no files under learnings (only dirs from writeVault)
      // (The dir is created, just empty of files.)
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghqRoot, { recursive: true, force: true });
    }
  });

  it("--seed with missing parent vault is a logged skip (no throw)", async () => {
    const ghqRoot = mkdtempSync(join(tmpdir(), "maw-ghq-"));
    // Note: no parent tree created
    const dir = mkGitRepo();
    try {
      const mod = await installConfigMock(ghqRoot);
      await mod.cmdBudFromRepo({
        target: dir, stem: "child", isUrl: false, pr: false, dryRun: false,
        from: "ghost-parent", seed: true,
      });
      // Injection still succeeds — vault exists
      expect(existsSync(join(dir, "ψ", "inbox"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghqRoot, { recursive: true, force: true });
    }
  });

  it("--sync-peers copies host peers.json to <target>/ψ/peers.json", async () => {
    const peersDir = mkdtempSync(join(tmpdir(), "maw-peers-"));
    const peersSrc = join(peersDir, "peers.json");
    const content = JSON.stringify({ version: 1, peers: { alice: { url: "https://a.example", node: "a", addedAt: "2026-04-19T00:00:00Z", lastSeen: null } } }, null, 2) + "\n";
    writeFileSync(peersSrc, content);
    process.env.PEERS_FILE = peersSrc;

    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false,
        syncPeers: true,
      });
      const dst = join(dir, "ψ", "peers.json");
      expect(existsSync(dst)).toBe(true);
      expect(readFileSync(dst, "utf-8")).toBe(content);
    } finally {
      if (prevPeersFile === undefined) delete process.env.PEERS_FILE;
      else process.env.PEERS_FILE = prevPeersFile;
      rmSync(dir, { recursive: true, force: true });
      rmSync(peersDir, { recursive: true, force: true });
    }
  });

  it("--sync-peers with no source peers.json is a logged skip", async () => {
    const peersDir = mkdtempSync(join(tmpdir(), "maw-peers-"));
    process.env.PEERS_FILE = join(peersDir, "does-not-exist.json");

    const dir = mkGitRepo();
    try {
      await cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false,
        syncPeers: true,
      });
      expect(existsSync(join(dir, "ψ", "peers.json"))).toBe(false);
      // Injection still succeeded
      expect(existsSync(join(dir, "ψ", "inbox"))).toBe(true);
    } finally {
      if (prevPeersFile === undefined) delete process.env.PEERS_FILE;
      else process.env.PEERS_FILE = prevPeersFile;
      rmSync(dir, { recursive: true, force: true });
      rmSync(peersDir, { recursive: true, force: true });
    }
  });
});

