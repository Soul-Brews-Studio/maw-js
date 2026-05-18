/**
 * #1775 — findWorktrees should find cross-repo worktrees when oracle name
 * differs from repo name. Without the oracle arg it stays backward-compat.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findWorktrees } from "../src/commands/shared/wake-resolve-impl";

const TMP_BASE = mkdtempSync(join(tmpdir(), "maw-1775-"));

beforeAll(() => {
  // Simulate ghq org dir holding repos for the same oracle "homekeeper":
  //   parentDir/homelab.wt-1-white          (main repo, default scan)
  //   parentDir/homekeeper-oracle.wt-2-white (oracle-suffixed, cross-repo)
  //   parentDir/homekeeper.wt-3-white        (oracle direct)
  //   parentDir/other-repo.wt-9-white        (unrelated repo — MUST NOT match)
  for (const name of [
    "homelab.wt-1-white",
    "homekeeper-oracle.wt-2-white",
    "homekeeper.wt-3-white",
    "other-repo.wt-9-white",
    "mother-oracle",
    "volt-oracle.wt-1-white",
  ]) {
    mkdirSync(join(TMP_BASE, name), { recursive: true });
  }
});

afterAll(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe("findWorktrees · #1775 cross-repo scan", () => {
  test("without oracle arg — backward compat: only main repo's wt", async () => {
    const wts = await findWorktrees(TMP_BASE, "homelab");
    const names = wts.map(w => w.name).sort();
    expect(names).toEqual(["1-white"]);
  });

  test("with oracle arg — finds main repo + oracle-suffixed + oracle-direct", async () => {
    const wts = await findWorktrees(TMP_BASE, "homelab", "homekeeper");
    const names = wts.map(w => w.name).sort();
    expect(names).toEqual(["1-white", "2-white", "3-white"]);
  });

  test("does NOT over-glob unrelated repos (#1780 guard)", async () => {
    const wts = await findWorktrees(TMP_BASE, "homelab", "homekeeper");
    const paths = wts.map(w => w.path);
    for (const p of paths) {
      expect(p.includes("other-repo")).toBe(false);
    }
  });

  test("oracle === repoName: behaves as backward-compat (no dup pattern)", async () => {
    const wts = await findWorktrees(TMP_BASE, "homelab", "homelab");
    const names = wts.map(w => w.name).sort();
    expect(names).toEqual(["1-white"]);
  });

  test("dedup: same path matched by multiple patterns counted once", async () => {
    // homelab pattern matches homelab.wt-*; if oracle were also "homelab"
    // (degenerate), Set dedup prevents double-listing.
    const wts = await findWorktrees(TMP_BASE, "homelab", "homelab");
    const paths = wts.map(w => w.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("#1780 guard: oracle=mother does NOT match volt-oracle.wt-*", async () => {
    // Mimic real #1780 symptom — mother shouldn't attach to volt's wt
    const wts = await findWorktrees(TMP_BASE, "mother-oracle", "mother");
    const names = wts.map(w => w.path.split("/").pop()!);
    for (const n of names) {
      expect(n.startsWith("volt-")).toBe(false);
      expect(n.startsWith("homekeeper-")).toBe(false);
    }
  });
});
