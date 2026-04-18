import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InvokeContext } from "../../../plugin/types";
import { planFromRepoInjection, looksLikeUrl, cmdBudFromRepo } from "./from-repo";

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
      expect(kinds.some(k => k.startsWith("skip:fleet/"))).toBe(true);
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

  it("blocks URL targets as not-yet-supported", () => {
    const plan = planFromRepoInjection({
      target: "https://github.com/x/y", stem: "demo", isUrl: true, pr: false, dryRun: true,
    });
    expect(plan.blockers.some(b => b.includes("not yet supported"))).toBe(true);
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

  it("non-dry-run always refuses with pointer to #588", async () => {
    const dir = mkGitRepo();
    try {
      await expect(cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: false, dryRun: false,
      })).rejects.toThrow(/not yet implemented — see #588/);
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
