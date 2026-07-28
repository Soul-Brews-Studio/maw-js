import { describe, expect, test } from "bun:test";
import { classifySignTiers, SENSITIVE_PATHS, LARGE_DIFF_LINE_THRESHOLD, type DiffFile } from "./sign-tier-classifier";

// kobo-546: every AC here is "the case we're afraid of," not a mechanism test —
// per the card's own explicit callout, a test that only proves a helper returns
// the right value for a value it was handed does NOT count. Each test below
// feeds a REALISTIC diff shape and checks the classifier's actual verdict.

describe("classifySignTiers (kobo-546) — fail-closed unhappy paths", () => {
  test("unreadable diff (gh failed / no PR to read) → 2 tiers", () => {
    expect(classifySignTiers(null)).toEqual({ tiers: ["crew", "head"], reason: expect.stringContaining("unreadable") });
  });

  test("empty diff (PR with zero changed files) → 2 tiers, not treated as harmless", () => {
    const r = classifySignTiers([]);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("empty diff");
  });
});

describe("classifySignTiers (kobo-546) — sensitive path always wins", () => {
  test("touches the sign/merge gate code itself (store.ts) → 2 tiers, THE case that bites if a future dev quietly softens the gate through the gate's own file", () => {
    const files: DiffFile[] = [{ path: "src/core/tasks/store.ts", additions: 3, deletions: 1 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("src/core/tasks/store.ts");
  });

  test("touches route.ts (board projection) → 2 tiers even for a tiny one-line diff", () => {
    const files: DiffFile[] = [{ path: "src/core/tasks/route.ts", additions: 1, deletions: 0 }];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });

  test("touches CI config → 2 tiers", () => {
    const files: DiffFile[] = [{ path: ".github/workflows/ci.yml", additions: 2, deletions: 0 }];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });

  test("touches teardown/kill helper → 2 tiers (kobo-362: an empty target here kills the wrong session)", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/crew/teardown.ts", additions: 1, deletions: 1 }];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });

  test("a large diff that touches ONE dangerous path among many safe ones still gets 2 tiers — the exact slip-through rule 3 warns about", () => {
    const files: DiffFile[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ path: `src/vendor/mpr-plugins/whoami/f${i}.ts`, additions: 5, deletions: 0 })),
      { path: "src/core/tasks/store.ts", additions: 1, deletions: 0 },
    ];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });

  test("path matches MULTIPLE sensitive categories at once — strictest wins is trivially true (every category maps to 2 tiers), still resolves cleanly, no crash/ambiguity", () => {
    // task/index.ts is BOTH "sign/merge gate code itself" and "resolve actor / sign auth"
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/task/index.ts", additions: 1, deletions: 0 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
  });
});

describe("classifySignTiers (kobo-546) — safe diffs stay 1 tier", () => {
  test("a plain, non-sensitive source file with no test-file deletions → 1 tier (head only)", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 4, deletions: 1 }];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });

  test("a typo-fix diff (small, safe path) → 1 tier — the whole point of the card, small work pays 1 tier", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/README.md", additions: 1, deletions: 1 }];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });
});

describe("classifySignTiers (kobo-546) rule 6 — test-file mechanical rule, no interpretation", () => {
  test("a test file diff with a deletion line (edits an existing assertion) → 2 tiers, can't verify it wasn't weakened", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/index.test.ts", additions: 2, deletions: 1 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("test file");
  });

  test("a test file diff that is PURE ADDITION (zero deletions) → 1 tier", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/index.test.ts", additions: 5, deletions: 0 }];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });

  test("kobo-510's OWN shape: a test-only PR whose entire content is the AC-pinning assertion — must be 2 tiers if it carries ANY deletion, exactly the case that let a removed field pass 68/68 green", () => {
    const files: DiffFile[] = [{ path: "src/views/company.test.ts", additions: 6, deletions: 2 }];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });
});

describe("classifySignTiers (kobo-546) — mutation proof: the classifier itself must be able to fail red", () => {
  test("if the sensitive-path check is bypassed, a hash/idempotency-path diff would wrongly classify as 1 tier — MUTATION of the real code proves the guard is load-bearing", () => {
    // Directly exercises the exact scenario the card's own GWT names as "the case
    // we're most afraid of": PR touches a sensitive category, classifier says small.
    const files: DiffFile[] = [{ path: "src/core/payments/hash-dedup.ts", additions: 2, deletions: 0 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]); // fails red if SENSITIVE_PATHS' hash/idempotency entry is ever removed
  });

  test("money-path diff → 2 tiers", () => {
    const files: DiffFile[] = [{ path: "src/core/billing/charge.ts", additions: 3, deletions: 0 }];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });
});

describe("SENSITIVE_PATHS (kobo-546) — table lives in code, ONE list, seed count pinned", () => {
  test("exactly the 11 seeded categories exist (6 from the lead + 5 proven live) — a future accidental deletion goes red here", () => {
    expect(SENSITIVE_PATHS.length).toBe(11);
  });

  test("every category has a non-empty label (readable in a reviewer's finding, not an opaque index)", () => {
    for (const s of SENSITIVE_PATHS) expect(s.category.length).toBeGreaterThan(0);
  });
});

describe("classifySignTiers (kobo-546 REWORK) — %109's holes A + B", () => {
  test("HOLE A: the real auth trust root (authenticateActor, comm-send.ts:259) is sensitive, not just its caller", () => {
    const files: DiffFile[] = [{ path: "src/commands/shared/comm-send.ts", additions: 2, deletions: 0 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("comm-send.ts");
  });

  test("HOLE B: the MCP entry point that also builds merge argv + can push --single-tier (tools.ts:363) is sensitive", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/mcp/tools.ts", additions: 1, deletions: 1 }];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });

  // eq3 head review (PR#359 c1): the classifier's OWN path was in SENSITIVE_PATHS'
  // "sign/merge gate code itself" category with nothing pinning it directly — pulling
  // ONLY this path's clause out (leaving store.ts/task/index.ts/mcp/tools.ts in place)
  // left the whole suite green, because touching the brain of the gate classified as
  // 1 tier while every other row still had its own dedicated test.
  test("the classifier's OWN file (sign-tier-classifier.ts) is sensitive — closes the hole where removing just this path's clause stayed green", () => {
    const files: DiffFile[] = [{ path: "src/core/tasks/sign-tier-classifier.ts", additions: 1, deletions: 1 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("sign-tier-classifier.ts");
  });
});

describe("classifySignTiers (kobo-546 REWORK) — the 300-line threshold (eq3 lead's starting number)", () => {
  test("LARGE_DIFF_LINE_THRESHOLD is 300, exported from the SAME file as SENSITIVE_PATHS (rule 4 — one place)", () => {
    expect(LARGE_DIFF_LINE_THRESHOLD).toBe(300);
  });

  test("a diff with MORE than 300 changed lines, safe paths only → 2 tiers", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 250, deletions: 51 }];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("301");
  });

  test("EXACTLY 300 changed lines → still 1 tier (over the threshold, not at-or-over)", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 200, deletions: 100 }];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });

  test("a diff under 300 lines, safe paths → 1 tier", () => {
    const files: DiffFile[] = [{ path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 10, deletions: 5 }];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });

  test("a lockfile carrying thousands of lines is EXCLUDED from the count — a real small change stays 1 tier", () => {
    const files: DiffFile[] = [
      { path: "bun.lock", additions: 4000, deletions: 3800 },
      { path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 3, deletions: 1 },
    ];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });

  test("a generated/dist bundle is EXCLUDED from the count too", () => {
    const files: DiffFile[] = [
      { path: "dist/bundle.js", additions: 5000, deletions: 5000 },
      { path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 2, deletions: 0 },
    ];
    expect(classifySignTiers(files).tiers).toEqual(["head"]);
  });

  // kobo-546 REWORK item 4 (%109): gh reports 0 additions AND 0 deletions for a
  // binary/unreadable file — the case a large binary-heavy PR could otherwise
  // sneak under the threshold on.
  test("BINARY FAIL-CLOSED: a file reporting 0 additions and 0 deletions makes the WHOLE count undeterminable → 2 tiers, even alongside a tiny safe text diff", () => {
    const files: DiffFile[] = [
      { path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 1, deletions: 0 },
      { path: "assets/logo.png", additions: 0, deletions: 0 },
    ];
    const r = classifySignTiers(files);
    expect(r.tiers).toEqual(["crew", "head"]);
    expect(r.reason).toContain("can't be determined");
  });

  test("a large binary-heavy PR does NOT sneak under the threshold via 0/0 lines (the exact regression this closes)", () => {
    const files: DiffFile[] = [
      { path: "assets/huge-binary-1.bin", additions: 0, deletions: 0 },
      { path: "assets/huge-binary-2.bin", additions: 0, deletions: 0 },
      { path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 5, deletions: 2 }, // small, would otherwise be well under 300
    ];
    expect(classifySignTiers(files).tiers).toEqual(["crew", "head"]);
  });
});
