import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resetGhqRootCache } from "../src/config/ghq-root";

const cleanupHandler = (await import("../src/vendor/mpr-plugins/cleanup/index.ts?cleanup-worktrees-handler")).default;

let tempRoot: string | null = null;
const oldGhq = process.env.GHQ_ROOT;
const oldCwd = process.cwd();

afterEach(async () => {
  process.chdir(oldCwd);
  if (tempRoot) {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
        break;
      } catch (e: any) {
        if (e?.code !== "EBUSY" || i === 9) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
  tempRoot = null;
  if (oldGhq === undefined) delete process.env.GHQ_ROOT;
  else process.env.GHQ_ROOT = oldGhq;
  resetGhqRootCache();
});

describe("cleanup --worktrees handler", () => {
  test("routes --json through the worktree survey", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "maw-cleanup-handler-"));
    mkdirSync(join(tempRoot, "github.com"), { recursive: true });
    process.env.GHQ_ROOT = tempRoot;
    resetGhqRootCache();

    const result = await cleanupHandler({ source: "cli", args: ["--worktrees", "--json"] } as any);
    const payload = JSON.parse(result.output ?? "{}");

    expect(result.ok).toBe(true);
    expect(payload).toEqual({ ok: true, worktrees: [] });
  });

  test("help advertises worktree cleanup", async () => {
    const result = await cleanupHandler({ source: "cli", args: [] } as any);

    expect(result.output).toContain("maw cleanup --worktrees [--yes] [--json]");
  });

  test("forwards --repo and --scope for worktrees", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "maw-cleanup-handler-scope-"));
    const cwdRepo = join(tempRoot, "github.com", "owner", "repo");
    mkdirSync(cwdRepo, { recursive: true });
    process.chdir(cwdRepo);
    process.env.GHQ_ROOT = tempRoot;
    resetGhqRootCache();

    const result = await cleanupHandler({
      source: "cli",
      args: ["--worktrees", "--json", "--repo", "owner/repo", "--scope", "."],
    } as any);
    const payload = JSON.parse(result.output ?? "{}");

    expect(payload).toEqual({ ok: true, worktrees: [] });
  });
});
