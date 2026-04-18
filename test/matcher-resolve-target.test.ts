import { describe, test, expect } from "bun:test";
import {
  resolveByName,
  resolveSessionTarget,
  resolveWorktreeTarget,
} from "../src/core/matcher/resolve-target";

// Minimal session-shaped fixture — only `name` is required by the resolver.
type Session = { name: string; windows?: { index: number }[] };
const sess = (name: string): Session => ({ name, windows: [{ index: 0 }] });

describe("resolveByName — exact match", () => {
  test("exact (case-insensitive) match wins over fuzzy candidates", () => {
    // target "view" exists exactly AND several sessions fuzzy-match — exact must win
    const items = [sess("mawjs-view"), sess("view"), sess("mawui-view")];
    const r = resolveByName("view", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("view");
  });

  test("exact match is case-insensitive", () => {
    const items = [sess("Mawjs")];
    const r = resolveByName("MAWJS", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("Mawjs");
  });
});

describe("resolveByName — fuzzy match (single hit)", () => {
  test("suffix match → fuzzy (fleet-numbered session: 110-yeast)", () => {
    const items = [sess("110-yeast"), sess("120-brew")];
    const r = resolveByName("yeast", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("110-yeast");
  });

  test("prefix match → fuzzy (mawjs matches mawjs-view)", () => {
    const items = [sess("mawjs-view"), sess("other")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-view");
  });

  test("case-insensitive fuzzy — MAWJS matches mawjs-view", () => {
    const items = [sess("mawjs-view")];
    const r = resolveByName("MAWJS", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("mawjs-view");
  });
});

describe("resolveByName — ambiguous (2+ fuzzy hits)", () => {
  test("multiple suffix matches → ambiguous with all candidates", () => {
    const items = [
      sess("mawjs-view"),
      sess("mawui-view"),
      sess("skills-cli-view"),
      sess("unrelated"),
    ];
    const r = resolveByName("view", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      const names = r.candidates.map(c => c.name).sort();
      expect(names).toEqual(["mawjs-view", "mawui-view", "skills-cli-view"]);
    }
  });

  test("suffix-preferred over prefix (alpha.77) — `maw` → `110-maw`, NOT ambiguous with `maw-js`", () => {
    // User report (alpha.77): `maw a mawjs` was ambiguous between
    // `101-mawjs` (canonical NN-name session) and `mawjs-view` (aux view).
    // Suffix now wins because that's the maw tmux naming convention —
    // oracle sessions are `NN-oracle-name`. Prefix match is Tier 2b, only
    // tried when no suffix match exists.
    const items = [sess("maw-js"), sess("110-maw"), sess("other")];
    const r = resolveByName("maw", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") {
      expect(r.match.name).toBe("110-maw");
    }
  });

  test("prefix-only match (no suffix competitor) → fuzzy (Tier 2b)", () => {
    // With no `-maw` suffix in the list, Tier 2a is empty, Tier 2b fires.
    const items = [sess("maw-js"), sess("other")];
    const r = resolveByName("maw", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") {
      expect(r.match.name).toBe("maw-js");
    }
  });

  test("multiple suffix matches → ambiguous (Tier 2a)", () => {
    const items = [sess("101-mawjs"), sess("102-mawjs"), sess("other")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map(c => c.name).sort()).toEqual(["101-mawjs", "102-mawjs"]);
    }
  });

  test("multiple prefix matches (no suffix competitor) → ambiguous (Tier 2b)", () => {
    const items = [sess("mawjs-view"), sess("mawjs-debug"), sess("other")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map(c => c.name).sort()).toEqual(["mawjs-debug", "mawjs-view"]);
    }
  });

  test("ambiguous returns ALL candidates — does not truncate", () => {
    const items = Array.from({ length: 7 }, (_, i) => sess(`node${i}-view`));
    const r = resolveByName("view", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(7);
  });
});

describe("resolveByName — no match", () => {
  test("zero matches → none", () => {
    const items = [sess("alpha"), sess("beta-core")];
    const r = resolveByName("nonesuch", items);
    expect(r.kind).toBe("none");
  });

  test("pure none has no hints field when nothing even substring-matches", () => {
    const items = [sess("alpha"), sess("beta-core")];
    const r = resolveByName("xyz", items);
    expect(r.kind).toBe("none");
    if (r.kind === "none") expect(r.hints).toBeUndefined();
  });

  test("empty target → none (does not match everything)", () => {
    const items = [sess("a"), sess("b-c")];
    const r = resolveByName("", items);
    expect(r.kind).toBe("none");
  });

  test("whitespace-only target → none", () => {
    const items = [sess("a"), sess("b-c")];
    const r = resolveByName("   ", items);
    expect(r.kind).toBe("none");
  });

  test("empty item list → none", () => {
    const r = resolveByName("view", []);
    expect(r.kind).toBe("none");
  });

  test("bare substring (not prefix/suffix boundary) does NOT match", () => {
    // "iew" is a substring of "view" but not suffix -iew or prefix iew-
    const items = [sess("mawjs-view")];
    const r = resolveByName("iew", items);
    expect(r.kind).toBe("none");
  });
});

describe("resolveSessionTarget — #535 regression (numeric-prefix fleet collision)", () => {
  test("`mawjs` does NOT match `114-mawjs-no2` via middle segment", () => {
    // Repro: fleet has oracle `mawjs-no2` (Bloom) with session `114-mawjs-no2`.
    // User types `mawjs` expecting their own oracle. Pre-fix: Tier 2b matched
    // `-mawjs-` middle segment → silently resolved to the wrong oracle.
    // Post-fix: numeric-prefix sessions skip Tier 2b; only Tier 2a (exact `-mawjs`
    // suffix) can match them → no suffix match → `none`.
    const items = [sess("114-mawjs-no2")];
    const r = resolveSessionTarget("mawjs", items);
    expect(r.kind).toBe("none");
  });

  test("`cli` still resolves via middle segment for non-numeric session names", () => {
    // Sanity check: the #535 fix must not break the `cli` → `skills-cli-view`
    // middle-match case (that session has no numeric prefix).
    const items = [sess("skills-cli-view"), sess("114-mawjs-no2")];
    const r = resolveSessionTarget("cli", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("skills-cli-view");
  });

  test("numeric-prefix fleet session still resolves via Tier 2a exact suffix", () => {
    // Sanity check: `mawjs` → `101-mawjs` (exact suffix) still works.
    const items = [sess("101-mawjs"), sess("114-mawjs-no2")];
    const r = resolveSessionTarget("mawjs", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("101-mawjs");
  });

  test("`mawjs-no2` correctly resolves to its own fleet session", () => {
    // The other half of the #535 test: typing the actual oracle name works.
    const items = [sess("114-mawjs-no2"), sess("101-mawjs")];
    const r = resolveSessionTarget("mawjs-no2", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("114-mawjs-no2");
  });

  test("worktree path (no fleetSessions flag) still middle-matches numeric prefixes", () => {
    // Guard-rail: #535 fix must NOT break worktree resolution. Worktrees use
    // numeric prefixes as sequence counters, not fleet-name boundaries, so
    // `pay` matching `2-pay-v1` via `-pay-` is correct.
    const items = [{ name: "2-pay-v1" }, { name: "2-pay-v2" }];
    const r = resolveWorktreeTarget("pay", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map(c => c.name).sort()).toEqual(["2-pay-v1", "2-pay-v2"]);
    }
  });

  test("default resolveByName (no options) treats numeric prefixes as worktree-style", () => {
    // Backward compat: resolveByName without options preserves old behaviour
    // (matches numeric-prefix items via Tier 2b). Session callers must use
    // resolveSessionTarget to opt in to the fleetSessions guard.
    const items = [sess("114-mawjs-no2")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("114-mawjs-no2");
  });
});

describe("resolveByName — word-segment middle match (NEW)", () => {
  test("middle-segment match: target 'cli' matches 'skills-cli-view' via -cli-", () => {
    const items = [sess("skills-cli-view"), sess("unrelated")];
    const r = resolveByName("cli", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("skills-cli-view");
  });

  test("middle-segment with multiple hits → ambiguous", () => {
    const items = [
      sess("skills-cli-view"),
      sess("maw-cli-tool"),
      sess("other"),
    ];
    const r = resolveByName("cli", items);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      const names = r.candidates.map(c => c.name).sort();
      expect(names).toEqual(["maw-cli-tool", "skills-cli-view"]);
    }
  });
});

describe("resolveByName — substring hints on none (NEW)", () => {
  test("substring fallback populates hints but kind stays 'none'", () => {
    // target "maw" matches nothing by word-segment (all three end in -view,
    // none start with maw-, none have -maw-). But all contain "maw" as a
    // substring — surface them as hints for a "did you mean?" render.
    const items = [sess("mawjs-view"), sess("mawjs-view-view"), sess("mawui-view")];
    const r = resolveByName("maw", items);
    expect(r.kind).toBe("none");
    if (r.kind === "none") {
      expect(r.hints).toBeDefined();
      const names = r.hints!.map(h => h.name).sort();
      expect(names).toEqual(["mawjs-view", "mawjs-view-view", "mawui-view"]);
    }
  });

  test("substring fallback with single hit is STILL none (never fuzzy)", () => {
    // The contract: substring matches never auto-pick. A single substring
    // match still returns `none` with one hint — the caller must refuse.
    const items = [sess("mawjs-view")];
    const r = resolveByName("awjs", items); // substring only, no word-segment boundary
    expect(r.kind).toBe("none");
    if (r.kind === "none") {
      expect(r.hints).toHaveLength(1);
      expect(r.hints![0]!.name).toBe("mawjs-view");
    }
  });

  test("word-segment match wins over substring: hints NOT populated on ambiguous", () => {
    // target "mawjs" hits two word-segment matches (both start with mawjs-).
    // Result must be ambiguous — no substring hints, no fallback to "none".
    const items = [sess("mawjs-view"), sess("mawjs-core"), sess("other")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("ambiguous");
    // ambiguous has no `hints` field by shape — asserting kind is enough,
    // but be explicit: word-segment wins and substring-fallback is skipped.
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  test("word-segment match wins over substring: single fuzzy, hints not populated", () => {
    // target "mawjs" has one word-segment hit AND would also substring-match
    // the same item. Result must be fuzzy — substring hints are skipped entirely.
    const items = [sess("mawjs-view"), sess("other")];
    const r = resolveByName("mawjs", items);
    expect(r.kind).toBe("fuzzy");
  });
});

describe("resolveByName — target trimming", () => {
  test("whitespace-trimmed target still resolves exact", () => {
    const items = [sess("view"), sess("mawjs-view")];
    const r = resolveByName("  view  ", items);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.match.name).toBe("view");
  });

  test("whitespace-trimmed target still resolves fuzzy", () => {
    const items = [sess("110-yeast")];
    const r = resolveByName("\tyeast\n", items);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") expect(r.match.name).toBe("110-yeast");
  });
});

describe("resolveByName — generic over other shapes", () => {
  test("worktree-shaped items ({name, path}) work via the generic", () => {
    type Worktree = { name: string; path: string };
    const trees: Worktree[] = [
      { name: "mawjs-view", path: "/tmp/mawjs-view" },
      { name: "mawjs-fix", path: "/tmp/mawjs-fix" },
    ];
    const r = resolveByName<Worktree>("fix", trees);
    expect(r.kind).toBe("fuzzy");
    if (r.kind === "fuzzy") {
      // Proves the generic preserves the full item type, not just { name }
      expect(r.match.path).toBe("/tmp/mawjs-fix");
    }
  });

  test("resolveSessionTarget and resolveWorktreeTarget are the same helper", () => {
    const items = [sess("110-yeast")];
    const a = resolveSessionTarget("yeast", items);
    const b = resolveWorktreeTarget("yeast", items);
    expect(a).toEqual(b);
  });
});
