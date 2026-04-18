import { describe, it, expect, mock, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InvokeContext } from "../../../plugin/types";
import { planFromRepoInjection, looksLikeUrl, cmdBudFromRepo } from "./from-repo";
import { applyFromRepoInjection, oracleMarkerBegin } from "./from-repo-exec";

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

  it("non-dry-run with --pr refuses with pointer to follow-up", async () => {
    const dir = mkGitRepo();
    try {
      await expect(cmdBudFromRepo({
        target: dir, stem: "demo", isUrl: false, pr: true, dryRun: false,
      })).rejects.toThrow(/--pr is not yet implemented/);
      // refuse BEFORE writing — no ψ/ created
      expect(existsSync(join(dir, "ψ"))).toBe(false);
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
