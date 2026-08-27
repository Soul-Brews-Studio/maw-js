import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isStrictlyInside, worktreeContainment } from "../src/vendor/mpr-plugins/done/done-worktree";

/**
 * `maw done` removes a worktree named by an attacker-controllable fleet
 * `win.worktree`/`win.repo` value, so the value is contained before it reaches
 * `git worktree remove`. The tt3p layout symlinks each ghq repo dir
 * (`<reposRoot>/<org>/<repo>`) to `~/tt3p/product-hub/<repo>`, so a nested slot
 * realpath-resolves OUT of the ghq root — the old `isStrictlyInside(reposRoot,…)`
 * gate false-refused a LEGITIMATE slot (pilot #7). worktreeContainment contains
 * the slot against its OWN repo anchor instead, keeping every hostile rejection.
 *
 * Filesystem fixture (real dirs + real symlinks):
 *   reposRoot/TTT3P/realrepo/agents/1-wt-good      (all real)
 *   reposRoot/TTT3P/realrepo.wt-legacy             (legacy sibling, real)
 *   reposRoot/TTT3P/symrepo  ->  productHub/symrepo (ghq→product-hub symlink)
 *   productHub/symrepo/agents/1-wt-sym             (real slot inside the symlinked repo)
 *   productHub/symrepo/agents/escape -> outside/    (symlink escaping the repo)
 */
let tmpRoot: string;
let reposRoot: string;

beforeAll(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "maw-containment-")));
  reposRoot = join(tmpRoot, "reposRoot");
  const productHub = join(tmpRoot, "product-hub");
  const outside = join(tmpRoot, "outside");

  mkdirSync(join(reposRoot, "TTT3P", "realrepo", "agents", "1-wt-good"), { recursive: true });
  mkdirSync(join(reposRoot, "TTT3P", "realrepo.wt-legacy"), { recursive: true });
  mkdirSync(join(productHub, "symrepo", "agents", "1-wt-sym"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  // The tt3p repo-dir symlink: ghq repo dir → product-hub repo.
  symlinkSync(join(productHub, "symrepo"), join(reposRoot, "TTT3P", "symrepo"));
  // A hostile symlink INSIDE the slot that escapes the repo.
  symlinkSync(outside, join(productHub, "symrepo", "agents", "escape"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("worktreeContainment — accepts legitimate slots", () => {
  test("real nested slot is accepted", () => {
    const r = worktreeContainment(reposRoot, "TTT3P/realrepo/agents/1-wt-good");
    expect(r).not.toBeNull();
    expect(r!.parsed.mainPath).toBe(join(reposRoot, "TTT3P", "realrepo"));
  });

  test("nested slot inside a ghq→product-hub SYMLINKED repo dir is accepted (pilot #7)", () => {
    const r = worktreeContainment(reposRoot, "TTT3P/symrepo/agents/1-wt-sym");
    expect(r).not.toBeNull();
    expect(r!.fullPath).toBe(join(reposRoot, "TTT3P", "symrepo", "agents", "1-wt-sym"));
  });

  test("legacy `.wt-` sibling worktree is still accepted (no regression)", () => {
    const r = worktreeContainment(reposRoot, "TTT3P/realrepo.wt-legacy");
    expect(r).not.toBeNull();
    expect(r!.parsed.layout).toBe("legacy");
  });
});

describe("worktreeContainment — rejects hostile / malformed values", () => {
  test("`../` traversal is rejected lexically", () => {
    expect(worktreeContainment(reposRoot, "../../tmp/evil.wt-x")).toBeNull();
  });

  test("an absolute path is rejected", () => {
    expect(worktreeContainment(reposRoot, "/etc/passwd.wt-x")).toBeNull();
    expect(worktreeContainment(reposRoot, join(tmpRoot, "outside") + ".wt-x")).toBeNull();
  });

  test("a symlink INSIDE the slot escaping the repo is rejected", () => {
    expect(worktreeContainment(reposRoot, "TTT3P/symrepo/agents/escape")).toBeNull();
  });

  test("depth injection (anchor ≠ parsed.mainPath) is rejected", () => {
    // parsed.mainPath = TTT3P/symrepo/sub, anchor from first two segs = TTT3P/symrepo.
    expect(worktreeContainment(reposRoot, "TTT3P/symrepo/sub/agents/x")).toBeNull();
  });

  test("a non-worktree path (no agents/, no .wt-) is rejected", () => {
    expect(worktreeContainment(reposRoot, "TTT3P/realrepo")).toBeNull();
  });
});

describe("regression proof: the OLD ghq-root gate false-refused the symlinked slot", () => {
  test("isStrictlyInside(reposRoot, symlinked-slot) is false, worktreeContainment accepts it", () => {
    const slot = join(reposRoot, "TTT3P", "symrepo", "agents", "1-wt-sym");
    // Old gate: realpath(slot) is under product-hub, not reposRoot → false.
    expect(isStrictlyInside(reposRoot, slot)).toBe(false);
    // New gate: contained against its own repo anchor → accepted.
    expect(worktreeContainment(reposRoot, "TTT3P/symrepo/agents/1-wt-sym")).not.toBeNull();
  });
});
