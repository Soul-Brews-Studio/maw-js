import { describe, test, expect } from "bun:test";

/**
 * Tests for `maw bud --root` flag — parentless oracle creation.
 *
 * Background: `maw bud` historically required a parent oracle (via `--from`
 * or tmux-cwd auto-detect). The `--root` flag (PR #254, feat/bud-root)
 * relaxes that so fresh-shell usage works: `maw bud white-wormhole --root`
 * creates a root oracle with no parent lineage.
 *
 * cmdBud is large and effectful (hostExec, gh, ghq, fs writes, git push),
 * so following the wake.test.ts convention we inline the small branching
 * helpers and test their semantic outcomes without triggering side effects.
 * If bud.ts changes shape, these helpers need to be updated in lock-step
 * (same trade-off wake.test.ts accepts for isPaneIdle).
 */

// ---- Helpers inlined from src/commands/bud.ts ------------------------------

/** Mirrors the parent-resolution block at the top of cmdBud. */
function resolveParent(
  opts: { from?: string; root?: boolean },
  tmuxCwdName: string | null,
): string | null | "ERROR" {
  let parentName: string | null = opts.from || null;
  if (!parentName && !opts.root) {
    if (tmuxCwdName === null) return "ERROR"; // cmdBud would process.exit(1)
    parentName = tmuxCwdName.replace(/-oracle$/, "").replace(/\.wt-.*$/, "");
  }
  return parentName;
}

/** Mirrors the "new fleet config" block in cmdBud (post-rebase, PR #253 + #254). */
function buildNewFleetConfig(args: {
  name: string;
  org: string;
  budRepoName: string;
  budNum: number;
  parentName: string | null;
  nowIso: string;
}): Record<string, unknown> {
  const { name, org, budRepoName, budNum, parentName, nowIso } = args;
  const cfg: Record<string, unknown> = {
    name: `${String(budNum).padStart(2, "0")}-${name}`,
    windows: [{ name: `${name}-oracle`, repo: `${org}/${budRepoName}` }],
    sync_peers: parentName ? [parentName] : [],
  };
  if (parentName) {
    cfg.budded_from = parentName;
    cfg.budded_at = nowIso;
  }
  return cfg;
}

/** Mirrors CLAUDE.md header + identity-field generation in cmdBud. */
function buildClaudeMdLineage(parentName: string | null, now: string): {
  header: string;
  field: string;
} {
  return {
    header: parentName
      ? `> Budded from **${parentName}** on ${now}`
      : `> Root oracle — born ${now} (no parent lineage)`,
    field: parentName
      ? `- **Budded from**: ${parentName}`
      : `- **Origin**: root (no parent)`,
  };
}

// ---- Tests ----------------------------------------------------------------

describe("maw bud --root — parent resolution", () => {
  test("--root alone → parentName is null (no tmux detection attempted)", () => {
    expect(resolveParent({ root: true }, "some-oracle")).toBeNull();
  });

  test("--root with no tmux context → still null (doesn't error)", () => {
    expect(resolveParent({ root: true }, null)).toBeNull();
  });

  test("--from wins over --root when both set (explicit parent beats implicit root)", () => {
    // Documenting intentional semantics: --root means "don't REQUIRE a parent",
    // not "forbid a parent". --from is always honored if present.
    expect(resolveParent({ root: true, from: "mawjs" }, null)).toBe("mawjs");
  });

  test("no --root, no --from, tmux cwd 'mawjs-oracle' → parentName 'mawjs'", () => {
    expect(resolveParent({}, "mawjs-oracle")).toBe("mawjs");
  });

  test("no --root, no --from, worktree cwd → .wt- suffix stripped (pre-existing regex order leaves -oracle)", () => {
    // NOTE: bud.ts currently runs `.replace(/-oracle$/)` BEFORE `.replace(/\.wt-.*$/)`,
    // so for "mawjs-oracle.wt-feat-x" the -oracle$ match fails (because .wt- is
    // at the end), only the .wt- suffix is stripped. Result is "mawjs-oracle",
    // not "mawjs". This is pre-existing (not PR #254) and worth filing, but
    // the test documents actual behavior so regressions here are visible.
    expect(resolveParent({}, "mawjs-oracle.wt-feat-x")).toBe("mawjs-oracle");
  });

  test("no --root, no --from, no tmux cwd → error sentinel (would process.exit)", () => {
    expect(resolveParent({}, null)).toBe("ERROR");
  });
});

describe("maw bud --root — fleet config shape", () => {
  const nowIso = "2026-04-11T21:30:00.000Z";

  test("root bud → sync_peers: [], no budded_from, no budded_at", () => {
    const cfg = buildNewFleetConfig({
      name: "white-wormhole",
      org: "Soul-Brews-Studio",
      budRepoName: "white-wormhole-oracle",
      budNum: 42,
      parentName: null,
      nowIso,
    });
    expect(cfg.sync_peers).toEqual([]);
    expect(cfg.budded_from).toBeUndefined();
    expect(cfg.budded_at).toBeUndefined();
    expect(cfg.name).toBe("42-white-wormhole");
    expect(cfg.windows).toEqual([
      { name: "white-wormhole-oracle", repo: "Soul-Brews-Studio/white-wormhole-oracle" },
    ]);
  });

  test("parent bud → sync_peers: [parent], budded_from + budded_at set", () => {
    const cfg = buildNewFleetConfig({
      name: "alpha",
      org: "Soul-Brews-Studio",
      budRepoName: "alpha-oracle",
      budNum: 5,
      parentName: "mawjs",
      nowIso,
    });
    expect(cfg.sync_peers).toEqual(["mawjs"]);
    expect(cfg.budded_from).toBe("mawjs");
    expect(cfg.budded_at).toBe(nowIso);
  });

  test("fleet config serializes to JSON cleanly for both shapes", () => {
    const rootCfg = buildNewFleetConfig({
      name: "r", org: "O", budRepoName: "r-oracle", budNum: 1, parentName: null, nowIso,
    });
    const parentCfg = buildNewFleetConfig({
      name: "p", org: "O", budRepoName: "p-oracle", budNum: 2, parentName: "m", nowIso,
    });
    // Must round-trip through JSON without losing shape (fleet files are JSON).
    expect(JSON.parse(JSON.stringify(rootCfg))).toEqual(rootCfg);
    expect(JSON.parse(JSON.stringify(parentCfg))).toEqual(parentCfg);
  });
});

describe("maw bud --root — CLAUDE.md lineage header", () => {
  const now = "2026-04-11";

  test("root bud → 'Root oracle' header + 'Origin: root' identity field", () => {
    const { header, field } = buildClaudeMdLineage(null, now);
    expect(header).toContain("Root oracle");
    expect(header).toContain("no parent lineage");
    expect(header).toContain(now);
    expect(field).toContain("Origin");
    expect(field).toContain("root");
    expect(field).not.toContain("Budded from");
  });

  test("parent bud → 'Budded from X on DATE' header + 'Budded from: X' field", () => {
    const { header, field } = buildClaudeMdLineage("mawjs", now);
    expect(header).toContain("Budded from");
    expect(header).toContain("mawjs");
    expect(header).toContain(now);
    expect(field).toContain("Budded from");
    expect(field).toContain("mawjs");
    expect(field).not.toContain("Root oracle");
  });

  test("root bud header never mentions a parent name by accident", () => {
    const { header } = buildClaudeMdLineage(null, now);
    // Guard against null being stringified as "null" into the template.
    expect(header).not.toContain("null");
    expect(header).not.toContain("undefined");
  });
});

describe("maw bud --root — summary line sync_peers rendering", () => {
  // The summary line was: `sync_peers: [${parentName}]`
  // For root buds with parentName=null, this printed "sync_peers: [null]"
  // which is misleading. Fix: coalesce to empty string when null.
  function renderSyncPeersSummary(parentName: string | null): string {
    return `sync_peers: [${parentName || ""}]`;
  }

  test("parent bud prints 'sync_peers: [mawjs]'", () => {
    expect(renderSyncPeersSummary("mawjs")).toBe("sync_peers: [mawjs]");
  });

  test("root bud prints 'sync_peers: []' (not '[null]')", () => {
    expect(renderSyncPeersSummary(null)).toBe("sync_peers: []");
    expect(renderSyncPeersSummary(null)).not.toContain("null");
  });
});
