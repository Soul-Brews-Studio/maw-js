import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask, __setHeadShaFetcherForTest, __resetHeadShaFetcherForTest, __setPrDiffFetcherForTest, __resetPrDiffFetcherForTest, __setPatchIdFetcherForTest, __resetPatchIdFetcherForTest } from "../../src/vendor/mpr-plugins/task/index";
import {
  addTask,
  readTask,
  requiredSignTiers,
  missingSignTiers,
  sameSignerBothTiers,
  sameEvidenceLocusBothTiers,
  evidenceScopeViolation,
  formatSignEvidenceScope,
  signTask,
} from "../../src/core/tasks/store";
import { readWorklog, worklogPath, _resetWorklogCache } from "../../src/core/worklog/store";

// kobo-327: merge-gate — the 2-sign anti-race funnel enforced in software.
// In-process against runTask (the `maw company task` engine) + the store fns
// directly. Loaded from source = CURRENT code. The `merge` happy path shells to
// `gh` (unavailable/side-effecting here), so we assert only the pure-logic REFUSE
// gates — the part that actually enforces the funnel.

const dir = mkdtempSync(join(tmpdir(), "maw-signmerge-"));
const prev = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME; // kobo-335: --from authenticated against agent self
const prevTest = process.env.MAW_TEST_MODE;
const prevTmux = process.env.TMUX; // kobo-346: these 327/331/336 tests aren't pane-scoped
// kobo-557: sign now REFUSES when a PR is linked but its head-commit fetch fails
// (state C) — so the file's DEFAULT stub must return a real value (state B, the
// normal path), or every one of this file's ~20 PR-linked sign calls would refuse.
// Only the tests that specifically exercise state C override this locally.
const DEFAULT_TEST_HEAD_SHA = "sha-default-stub";

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  process.env.CLAUDE_AGENT_NAME = "eq3"; // kobo-335: harness acts AS eq3 (matches --from local:eq3)
  process.env.MAW_TEST_MODE = "1"; // kobo-335: suppress real notify/ping delivery to live panes
  delete process.env.TMUX; // kobo-346: no tmux → resolveSignerPane null → the pane guard is inert (these tests exercise oracle-grain sign/merge, not pane-identity)
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "eq3" }, { oracle: "patchwork" }], lead: "eq3" } } }),
  );
  // kobo-557: the sign-time SHA fetch now runs unconditionally (no MAW_TEST_MODE
  // branch in the gate path) — default to a REAL bound value (state B) so every
  // existing PR-linked sign-verb call in this file takes the normal path. Tests
  // exercising state C (gh fetch failure) or the --sha compare override this
  // locally and restore it in a finally/afterEach.
  __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
  // kobo-546 REWORK: the classify/escalate gate now runs unconditionally on every
  // `pr`/`merge` call (no MAW_TEST_MODE branch) — inject a safe, NON-EMPTY,
  // non-sensitive stub so the 43 `pr`/`merge` calls in this file never shell to
  // real gh. MUST be non-empty: classifySignTiers reads an empty diff as
  // fail-closed 2 tiers (DELIBERATE — the card's own unhappy path), so an empty
  // stub here would silently crew-gate every card in this suite. Do not "tidy"
  // this back to an empty array — that's the gate quietly dying, not a cleanup.
  __setPrDiffFetcherForTest(() => [{ path: "docs/README.md", additions: 1, deletions: 0 }]);
  // kobo-578 review round 1: same reasoning as the prDiffFetcher stub above —
  // ~22 calls in this file link a PR then sign via the CLI, so without an
  // injected stub `sign`'s `signedPatchId = before?.pr && before?.repo ?
  // patchIdFetcher(...) : undefined` shells to a REAL `gh pr diff` + `git
  // patch-id` every time (measured: +~13s on a 3-file run). Worse than slow:
  // if `gh` fails/rate-limits on a runner with no auth, the fetcher returns
  // undefined → isSignDowngrade always false → the feature silently no-ops
  // while tests stay green (the exact kobo-546 shape this file's own other
  // stub exists to avoid). Fixed non-varying value — the dedicated kobo-578
  // downgrade-detection tests call signTask() directly with explicit patchId
  // args, bypassing this fetcher entirely, so no test here needs the stub to
  // vary its return value.
  __setPatchIdFetcherForTest(() => "test-patch-id-stub");
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = prevTest;
  if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
  __resetHeadShaFetcherForTest(); // kobo-557: undo the injected stub — never leak into another test file
  __resetPrDiffFetcherForTest(); // kobo-546: undo the injected stub — never leak into another test file
  __resetPatchIdFetcherForTest(); // kobo-578: same — never leak into another test file
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies", "kobo", "tasks"), { recursive: true, force: true }); });

const run = async (args: string[]): Promise<{ ok: boolean; error?: string; output: string }> => {
  const out: string[] = [];
  const r = await runTask(args, (l) => out.push(l));
  return { ...r, output: out.join("\n") };
};
const task = (args: string[]) => run([...args, "--company", "kobo", "--from", "local:eq3"]);
// kobo-335/336: sign as a specific oracle — bind the --from claim to that agent self.
const signAs = async (oracle: string, id: string, role: string) => {
  const prevAgent = process.env.CLAUDE_AGENT_NAME;
  process.env.CLAUDE_AGENT_NAME = oracle;
  try { return await run(["sign", id, "--role", role, "--company", "kobo", "--from", `local:${oracle}`]); }
  finally { process.env.CLAUDE_AGENT_NAME = prevAgent; }
};

describe("kobo-327 merge-gate: store sign tiers", () => {
  test("requiredSignTiers: non-crew card = head only (the design crux — never hard-require crew)", () => {
    const t = addTask({ company: "kobo", title: "plain card", by: "eq3" });
    expect(requiredSignTiers(t)).toEqual(["head"]);
    expect(missingSignTiers(t)).toEqual(["head"]);
  });

  test("requiredSignTiers: crewGate card = crew + head", () => {
    const t = addTask({ company: "kobo", title: "crew card", by: "eq3", crewGate: true });
    expect(requiredSignTiers(t)).toEqual(["crew", "head"]);
    expect(missingSignTiers(t)).toEqual(["crew", "head"]);
  });

  test("signTask head: records who+ts, clears the head tier", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    const t = signTask("kobo", "kobo-1", "patchwork", "head")!;
    expect(t.headSignedBy).toBe("patchwork");
    expect(t.headSignedTs).toBeGreaterThan(0);
    expect(missingSignTiers(t)).toEqual([]); // head-only card now fully signed
  });

  test("signTask crew self-marks crewGate → card can't skip the crew tier", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" }); // born non-crew
    const t = signTask("kobo", "kobo-1", "patchwork", "crew")!;
    expect(t.crewGate).toBe(true); // a crew sign declares it a crew-tier card
    expect(missingSignTiers(t)).toEqual(["head"]); // crew in, head still needed
  });

  test("signTask is idempotent — re-sign refreshes who, no dup/error", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "a", "head");
    const t = signTask("kobo", "kobo-1", "b", "head")!;
    expect(t.headSignedBy).toBe("b");
    expect(missingSignTiers(t)).toEqual([]);
  });

  test("signTask on a missing id → null", () => {
    expect(signTask("kobo", "kobo-999", "x", "head")).toBeNull();
  });

  test("both signs collected → crewGate card mergeable (no missing tiers)", () => {
    addTask({ company: "kobo", title: "c", by: "eq3", crewGate: true });
    signTask("kobo", "kobo-1", "patchwork", "crew");
    const t = signTask("kobo", "kobo-1", "eq3", "head")!;
    expect(missingSignTiers(t)).toEqual([]);
  });
});

describe("kobo-327 merge-gate: runTask sign/merge verbs", () => {
  test("add --crew-gate marks the card", async () => {
    const r = await task(["add", "crew work", "--crew-gate"]);
    expect(r.ok).toBe(true);
    expect(readTask("kobo", "kobo-1")!.crewGate).toBe(true);
  });

  test("add without --crew-gate → no crewGate (single-tier)", async () => {
    await task(["add", "plain"]);
    expect(readTask("kobo", "kobo-1")!.crewGate).toBeUndefined();
  });

  test("sign --role crew then head (distinct oracles), output flags mergeability", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]); // kobo-557: sign now requires a linked PR to bind a SHA
    const c = await signAs("eq3", "kobo-1", "crew");
    expect(c.ok).toBe(true);
    expect(c.output).toContain("still needs: head");
    const h = await signAs("patchwork", "kobo-1", "head"); // kobo-336: distinct signer for head
    // kobo-576 review round 1: "mergeable" overclaimed what tier-vs-tier agreement
    // actually verifies — reworded to what was checked + the GitHub-at-merge caveat.
    expect(h.output).toContain("all tiers signed the same commit");
  });

  test("sign without --role → usage error", async () => {
    await task(["add", "c"]);
    const r = await task(["sign", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--role");
  });

  test("sign --role bogus → role error", async () => {
    await task(["add", "c"]);
    const r = await task(["sign", "kobo-1", "--role", "boss"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("crew or head");
  });

  test("sign missing id → not found", async () => {
    const r = await task(["sign", "kobo-999", "--role", "head"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  test("merge REFUSES a card with no linked PR", async () => {
    await task(["add", "c"]);
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no linked PR");
  });

  test("merge REFUSES until required signs are in (crewGate → crew missing)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("missing");
    expect(r.error).toContain("crew");
  });

  test("merge --method bogus → method error (after signs in, PR present)", async () => {
    await task(["add", "c"]); // head-only (crewGate unset → confirmed solo after kobo-333; --single-tier kept for backward compat)
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await task(["sign", "kobo-1", "--role", "head"]);
    const r = await task(["merge", "kobo-1", "--single-tier", "--method", "octopus"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--method");
  });
});

// eq3 head review (PR#359 c1): store.test.ts's own "mutation-anchor" test calls
// reclassifyAndEscalate DIRECTLY — it proves the function writes through, but it
// never exercises the merge CLI's own call site (task/index.ts:941, stage
// "merge-time"). Deleting that call site (or nulling its argument) leaves the
// function itself fully intact, so that test stays green either way — the exact
// hole eq3 found by mutating the real bind site and getting 323/323 green.
// This test goes through the real `merge` command instead, so it can only pass
// if the bind site actually ran.
describe("kobo-546 REWORK — merge-time reclassify is a CALL SITE, not just a function (eq3 head review c1)", () => {
  test("PR-open stamps 1-tier on a safe diff; the diff moves into a sensitive path before merge; merge REFUSES on a missing CREW sign, never on the unset-crewGate fail-closed message — the only way to tell task/index.ts:941 actually ran", async () => {
    await task(["add", "c"]); // pr-open will see the safe README stub → stays 1-tier
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await task(["sign", "kobo-1", "--role", "head"]);
    expect(readTask("kobo", "kobo-1")!.crewGate).toBeFalsy(); // pre-condition: genuinely still 1-tier

    __setPrDiffFetcherForTest(() => [{ path: "src/core/tasks/store.ts", additions: 1, deletions: 1 }]);
    try {
      const r = await task(["merge", "kobo-1"]);
      expect(r.ok).toBe(false);
      // If task/index.ts:941 were removed/no-op'd, crewGate would stay unset and
      // this would instead read "crewGate is not set" (kobo-331 fail-closed) —
      // a DIFFERENT error, from a different guard, that this assertion excludes.
      expect(r.error).not.toContain("crewGate is not set");
      expect(r.error).toContain("missing");
      expect(r.error).toContain("crew");
      expect(readTask("kobo", "kobo-1")!.crewGate).toBe(true); // escalation actually landed in the store
    } finally {
      __setPrDiffFetcherForTest(() => [{ path: "docs/README.md", additions: 1, deletions: 0 }]); // restore this file's safe default — never leak into later tests
    }
  });
});

// kobo-331: FAIL-CLOSED bootstrap gap — an unset crewGate is ambiguous (crew-cell
// pre-sign vs genuine single-tier), so merge REFUSES rather than falling through to a
// silent head-only merge (race #4, hit live on kobo-328). Two explicit escapes.
describe("kobo-331 fail-closed merge-gate", () => {
  test("merge REFUSES a crewGate-unset card with no explicit tier (fail-closed, not head-only)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await task(["sign", "kobo-1", "--role", "head"]); // head signed — 327 would have merged head-only
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("crewGate is not set");
    // REFUSE names BOTH escapes so the operator isn't stuck
    expect(r.error).toContain("--role crew");
    expect(r.error).toContain("--single-tier");
  });

  test("escape 2 — --single-tier passes fail-closed → only head required (no over-block, no crew)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    // --single-tier declares no-crew → past fail-closed; head still unsigned → lands on the
    // ordinary head-sign gate (NOT crewGate, NOT crew). Stops before gh (no real merge).
    const r = await task(["merge", "kobo-1", "--single-tier"]);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("crewGate is not set"); // fail-closed cleared
    expect(r.error).toContain("missing head"); // head-only: just the head sign remains required
  });

  test("--single-tier is REFUSED on a crew-gated card (can't skip the crew tier)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await task(["sign", "kobo-1", "--role", "crew"]);
    await task(["sign", "kobo-1", "--role", "head"]);
    const r = await task(["merge", "kobo-1", "--single-tier"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("crew-gated");
  });

  test("crew-gated card still refuses until BOTH signs (fail-closed unchanged for declared crew cards)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await task(["sign", "kobo-1", "--role", "head"]); // head only, crew missing
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("crew"); // missing crew sign
  });

  test("don't-wedge: an existing in-flight crewGate-unset card is escapable, never stuck", async () => {
    // simulates a card created before this change (crewGate never set) — it must remain
    // mergeable via the explicit escape, not permanently wedged by fail-closed.
    await task(["add", "legacy in-flight"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    const stuck = await task(["merge", "kobo-1"]);
    expect(stuck.error).toContain("crewGate is not set"); // refused by default
    const escaped = await task(["merge", "kobo-1", "--single-tier"]);
    expect(escaped.error).not.toContain("crewGate is not set"); // escape clears fail-closed
    expect(escaped.error).toContain("head"); // now just needs the ordinary head sign → not wedged
  });
});

// kobo-336: a crew card needs two INDEPENDENT signers — one oracle can't fill both
// the crew and head tier (self-review bypass the kobo-329 dogfood proved the gate let
// through). sign-time refuses early; merge is the authoritative backstop.
describe("kobo-336 distinct-signers", () => {
  test("sameSignerBothTiers: same oracle both tiers → the oracle; distinct/single → null", () => {
    expect(sameSignerBothTiers({ crewSignedBy: "eq3", headSignedBy: "eq3" } as any)).toBe("eq3");
    expect(sameSignerBothTiers({ crewSignedBy: "eq3", headSignedBy: "patchwork" } as any)).toBeNull();
    expect(sameSignerBothTiers({ headSignedBy: "eq3" } as any)).toBeNull(); // single-tier (no crew signer)
    expect(sameSignerBothTiers({} as any)).toBeNull();
  });

  test("sign-time REFUSE: same oracle signing the second tier is barred early", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]); // kobo-557: sign now requires a linked PR to bind a SHA
    expect((await signAs("eq3", "kobo-1", "crew")).ok).toBe(true);
    const dup = await signAs("eq3", "kobo-1", "head"); // eq3 already signed crew
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("already signed the crew tier");
    expect(readTask("kobo", "kobo-1")!.headSignedBy).toBeUndefined(); // bad state never recorded
  });

  test("merge REFUSE when both tiers signed by the same oracle (authoritative backstop)", async () => {
    // force the same-signer state directly via the store (bypass the sign-time guard) to
    // prove the merge gate independently catches it.
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "eq3", "crew");
    signTask("kobo", "kobo-1", "eq3", "head");
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("signed BOTH the crew and head tier");
  });

  test("distinct signers → merge passes the gate (327 unchanged, no over-block)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    expect((await signAs("patchwork", "kobo-1", "crew")).ok).toBe(true);
    expect((await signAs("eq3", "kobo-1", "head")).ok).toBe(true);
    // --method octopus lands on method-validation (AFTER the dupSigner gate, BEFORE gh) →
    // proves distinct signers passed the gate without invoking a real `gh pr merge`.
    const r = await task(["merge", "kobo-1", "--method", "octopus"]);
    expect(r.error).toContain("--method"); // reached method check = past the distinct-signer gate
    expect(r.error).not.toContain("signed BOTH");
  });

  test("single-tier (head-only, no crew) never over-blocked by the distinct-signer check", async () => {
    await task(["add", "c"]); // non-crew
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await signAs("eq3", "kobo-1", "head"); // only head; crewSignedBy stays unset
    const r = await task(["merge", "kobo-1", "--single-tier", "--method", "octopus"]);
    expect(r.error).not.toContain("signed BOTH"); // no crew signer → same-signer check is inert
    expect(r.error).toContain("--method"); // passes the gate head-only (no gh invoked)
  });
});

// kobo-400: bind a sign to the commit it reviewed — epic-326's last hole (a sign proved
// WHEN, not WHAT). crew/head SHAs must AGREE (a push between the two signers is a smaller
// version of the same self-review-bypass class kobo-336 exists to close — convergent
// discovery: found from the implementation side here, from the gate-semantics side by
// lead, independently, minutes apart). Legacy signs (no SHA at all, pre-kobo-400) are
// grandfathered — field-absence is the ONE trigger, no flag-day/timestamp logic.
describe("kobo-400 signSha hard-bind", () => {
  const origSpawnSync = Bun.spawnSync;
  afterAll(() => { Bun.spawnSync = origSpawnSync; });

  test("merge REFUSES when crew and head signed different commits", async () => {
    // guard the real gh binary regardless of gate outcome: if this refuse ever regressed,
    // the call would otherwise fall through to a REAL `gh pr merge` against a real repo.
    Bun.spawnSync = (() => { throw new Error("must not reach gh — the SHA-mismatch gate should have refused first"); }) as typeof Bun.spawnSync;
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", null, "sha-AAAA");
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-BBBB"); // a push happened between the two signers
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sha-AAAA");
    expect(r.error).toContain("sha-BBBB");
    expect(r.error).toContain("different commits");
  });

  test("merge passes the SHA-bind gate when crew and head signed the SAME commit", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", null, "sha-SAME");
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-SAME");
    // --method octopus stops AFTER the SHA-bind gate, BEFORE gh is ever invoked — same trick
    // the file already uses to prove the distinct-signer gate passed (line ~277).
    const r = await task(["merge", "kobo-1", "--method", "octopus"]);
    expect(r.error).toContain("--method"); // reached method check = past the SHA-bind gate
    expect(r.error).not.toContain("different commits");
  });

  test("merge grandfathers a fully-legacy sign (neither tier has a SHA) — warns, does not refuse", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew"); // no sha — pre-kobo-400 shape
    signTask("kobo", "kobo-1", "eq3", "head");
    const r = await task(["merge", "kobo-1", "--method", "octopus"]);
    expect(r.output).toContain("pre-signSha-bind sign"); // loud warning, stated plainly
    expect(r.output).toContain("kobo-404"); // follow-up reference (hard-enforce once legacy drains)
    expect(r.error).toContain("--method"); // still reached method check — not refused
  });

  test("merge grandfathers a PARTIALLY-legacy sign (one tier has a SHA, the other doesn't) — same as fully-legacy, no partial enforcement", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", null, "sha-ONLY-CREW");
    signTask("kobo", "kobo-1", "eq3", "head"); // legacy — no sha
    const r = await task(["merge", "kobo-1", "--method", "octopus"]);
    expect(r.output).toContain("pre-signSha-bind sign");
    expect(r.error).not.toContain("different commits"); // field-absence is the ONE trigger — no partial compare
    expect(r.error).toContain("--method");
  });

  test("single-tier (head-only) card: SHA-bind uses just the head SHA, no crew comparison needed", async () => {
    await task(["add", "c"]); // non-crew
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-SOLO");
    const r = await task(["merge", "kobo-1", "--single-tier", "--method", "octopus"]);
    expect(r.error).not.toContain("different commits");
    expect(r.output).not.toContain("pre-signSha-bind"); // head has a sha → not legacy
    expect(r.error).toContain("--method");
  });

  // Exploit-reality: mock `gh pr merge` to succeed, capture the argv it was actually
  // invoked with. Reverting the `if (matchHeadCommit) mergeArgv.push(...)` line makes
  // this assertion FAIL (the flag would never appear) — this pins the enforcement, not
  // just the refuse-path logic above.
  test("EXPLOIT-REALITY: a matching-SHA merge passes --match-head-commit to the real gh invocation", async () => {
    let capturedArgv: string[] | undefined;
    Bun.spawnSync = ((argv: string[]) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as typeof Bun.spawnSync;
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", null, "sha-REAL");
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-REAL");
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(true);
    expect(capturedArgv).toContain("--match-head-commit");
    expect(capturedArgv).toContain("sha-REAL");
  });

  test("EXPLOIT-REALITY companion: a legacy (no-SHA) merge does NOT pass --match-head-commit (nothing to bind)", async () => {
    let capturedArgv: string[] | undefined;
    Bun.spawnSync = ((argv: string[]) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as typeof Bun.spawnSync;
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew"); // legacy
    signTask("kobo", "kobo-1", "eq3", "head"); // legacy
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(true);
    expect(capturedArgv).not.toContain("--match-head-commit");
  });

  test("sign-time SHA capture default is the REAL gh fetcher, not a leaked stub (kobo-557)", async () => {
    // kobo-557 removed the MAW_TEST_MODE branch from the gate path itself (kobo-546's
    // lesson: an env check wrapping the CALL means the call, and any mutation to it,
    // never runs under test). This file's beforeAll stubs headShaFetcher to return a
    // fixed value for every OTHER test — this one resets to the real fetcher and mocks
    // Bun.spawnSync (this file's existing convention for the real `gh` boundary,
    // used throughout the describe above) to prove __resetHeadShaFetcherForTest
    // genuinely wires back to a real `gh pr view` shape, not an inert no-op.
    __resetHeadShaFetcherForTest();
    Bun.spawnSync = ((argv: string[]) => {
      expect(argv).toContain("gh");
      expect(argv).toContain("headRefOid");
      return { exitCode: 0, stdout: Buffer.from("sha-from-real-fetcher\n"), stderr: Buffer.from("") };
    }) as typeof Bun.spawnSync;
    try {
      await task(["add", "c"]);
      await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
      await signAs("eq3", "kobo-1", "head");
      expect(readTask("kobo", "kobo-1")!.headSignedSha).toBe("sha-from-real-fetcher");
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA); // restore this file's safe default
    }
  });
});

// kobo-557: comparing crew-sha vs head-sha at MERGE time (kobo-400, above) only proves
// the two tiers agree with EACH OTHER — never that either one read what it signed. Live
// incident (kobo-508): a push landed between a reviewer reading the diff and typing
// `sign`; the fetch silently re-bound the sign to the NEW head. If that happens before
// BOTH tiers sign, crew+head agree on the new commit without either having read it, and
// kobo-400's merge-time compare passes clean — merge succeeds with nobody having read
// what was merged. --sha makes the read explicit and refuses instead of re-binding.
// kobo-557: ONE rule going forward — "can't bind a SHA = don't sign." Three ways a
// sign can be refused (A: no PR linked, C: PR linked but the head fetch failed, D:
// --sha disagrees with the current head) plus the one success path (B: bound fine).
// The file's DEFAULT stub (beforeAll, top of file) returns a real value so every
// OTHER test in this file — the ~20 that link a PR and sign without caring about
// this card — takes path B and is unaffected; only the tests below override it.
describe("kobo-557 sign-time SHA-bind refuse (A/B/C/D)", () => {
  test("(A) sign REFUSES when no PR is linked yet — the kobo-556 shape (silent no-SHA success)", async () => {
    await task(["add", "c"]);
    const r = await task(["sign", "kobo-1", "--role", "head"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no PR linked");
    expect(r.error).toContain("maw company task pr"); // next-step guidance
    expect(readTask("kobo", "kobo-1")!.headSignedBy).toBeUndefined(); // never recorded
  });

  // Reviewer pre-screen point 5 (rated most important): the refuse must happen
  // BEFORE any store write, not just print the right message with the card already
  // mutated underneath. Redundant with the assertion above by design — if someone
  // moves the (A) check to after signTask, THIS is the assertion that catches it.
  test("(A) refuse happens before any store write — no crewSignedBy left dangling even for the OTHER tier", async () => {
    await task(["add", "c", "--crew-gate"]);
    const r = await task(["sign", "kobo-1", "--role", "crew"]);
    expect(r.ok).toBe(false);
    const t = readTask("kobo", "kobo-1")!;
    expect(t.crewSignedBy).toBeUndefined();
    expect(t.headSignedBy).toBeUndefined();
    expect(t.notes ?? []).toEqual([]); // nothing at all was recorded on this refuse
  });

  test("(B) a successful sign prints the bound SHA in its output line (kobo-557 AC8)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => "sha-visible-in-output");
    try {
      const r = await task(["sign", "kobo-1", "--role", "head"]);
      expect(r.ok).toBe(true);
      expect(r.output).toContain("sha-visible-in-output");
      expect(r.output).not.toContain("sign REFUSED for"); // must not carry any refuse marker (A/C/D all start with this) (reviewer pre-screen point 3)
      expect(readTask("kobo", "kobo-1")!.headSignedSha).toBe("sha-visible-in-output");
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  test("(C) sign ALLOWS through when the PR is linked but its head-commit fetch fails — Tony's ruling, kobo-404 posture (never block on this)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => undefined); // simulates a gh failure — PR IS linked
    try {
      const r = await task(["sign", "kobo-1", "--role", "head"]);
      expect(r.ok).toBe(true); // transient external failure never blocks a sign (kobo-404)
      expect(readTask("kobo", "kobo-1")!.headSignedBy).toBe("eq3"); // sign DID record
      expect(readTask("kobo", "kobo-1")!.headSignedSha).toBeUndefined(); // just unbound
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  test("(C) output line says plainly no SHA bound, and is DISTINCT from a bound (B) sign (AC8, reviewer pre-screen point 3)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => undefined);
    try {
      const r = await task(["sign", "kobo-1", "--role", "head"]);
      expect(r.output).toContain("NO SHA BOUND");
      expect(r.output).not.toContain("[sha "); // distinct from the bound-case label, not just present
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  test("(D) sign REFUSES when --sha disagrees with the CURRENT head, naming both", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => "sha-B-after-push"); // a push landed since the signer read sha-A
    try {
      const r = await task(["sign", "kobo-1", "--role", "head", "--sha", "sha-A-that-was-read"]);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("sha-A-that-was-read");
      expect(r.error).toContain("sha-B-after-push");
      expect(r.error).toContain("re-review"); // next-step guidance, not just a bare refusal
      expect(readTask("kobo", "kobo-1")!.headSignedBy).toBeUndefined(); // never recorded
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  // Reviewer pre-screen point 6: a compare weakened from strict equality to a
  // prefix/startsWith check would still refuse two UNRELATED shas (no shared
  // prefix) — this test forces the two values to share a prefix while remaining
  // genuinely different commits, so a startsWith-style compare wrongly reads them
  // as a match and this test goes red.
  test("(D) sign REFUSES on a --sha/head mismatch even when one is a PREFIX of the other (guards against a weakened startsWith compare)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => "abc123extra"); // current head — NOT equal to what was read, though it starts with it
    try {
      const r = await task(["sign", "kobo-1", "--role", "head", "--sha", "abc123"]);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("abc123");
      expect(r.error).toContain("abc123extra");
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  test("(D) sign PASSES normally when --sha matches the current head — no push interleaved, no regression on the normal path", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => "sha-A");
    try {
      const r = await task(["sign", "kobo-1", "--role", "head", "--sha", "sha-A"]);
      expect(r.ok).toBe(true);
      expect(readTask("kobo", "kobo-1")!.headSignedBy).toBe("eq3");
      expect(readTask("kobo", "kobo-1")!.headSignedSha).toBe("sha-A");
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  test("(D) push lands BEFORE either tier signs → BOTH crew and head are refused, not silently rebound (the card's core scenario — not inferred from a single-tier case)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => "sha-B-after-push"); // by the time EITHER signs, head has already moved past what both read
    const signAtWithSha = async (oracle: string, role: string, sha: string) => {
      const prevAgent = process.env.CLAUDE_AGENT_NAME;
      process.env.CLAUDE_AGENT_NAME = oracle;
      try { return await run(["sign", "kobo-1", "--role", role, "--sha", sha, "--company", "kobo", "--from", `local:${oracle}`]); }
      finally { process.env.CLAUDE_AGENT_NAME = prevAgent; }
    };
    try {
      const crew = await signAtWithSha("patchwork", "crew", "sha-A-both-read");
      const head = await signAtWithSha("eq3", "head", "sha-A-both-read");
      expect(crew.ok).toBe(false);
      expect(crew.error).toContain("sha-A-both-read");
      expect(crew.error).toContain("sha-B-after-push");
      expect(head.ok).toBe(false);
      expect(head.error).toContain("sha-A-both-read");
      expect(head.error).toContain("sha-B-after-push");
      expect(readTask("kobo", "kobo-1")!.crewSignedBy).toBeUndefined();
      expect(readTask("kobo", "kobo-1")!.headSignedBy).toBeUndefined();
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });

  test("omitting --sha keeps the legacy auto-bind path unchanged — no refuse, no regression for existing callers (no card holds mandatory-`--sha` yet — eq3 sent that question to Tony)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    __setHeadShaFetcherForTest(() => "sha-current-head");
    try {
      const r = await task(["sign", "kobo-1", "--role", "head"]); // no --sha — old callers unaffected
      expect(r.ok).toBe(true);
      expect(readTask("kobo", "kobo-1")!.headSignedSha).toBe("sha-current-head"); // still auto-binds, just no compare/refuse
    } finally {
      __setHeadShaFetcherForTest(() => DEFAULT_TEST_HEAD_SHA);
    }
  });
});

// kobo-501: a sign records a sha+pane but nothing about what EVIDENCE justified it — a
// diff-read sign and a mutation-verified sign were indistinguishable at merge time (the
// real kobo-482 shape: %5's own mutation artifact got counted toward BOTH tiers even
// though only one tier's sign actually did that work). Two guards, both must not collapse
// "unknown" into a value: omitted --evidence records "undeclared" (never "diff-read"), and
// a claimed test-run/mutation REQUIRES a locus (never opt-in free text).
describe("kobo-501 evidenceScopeViolation (pure)", () => {
  test("undeclared and diff-read need no locus", () => {
    expect(evidenceScopeViolation("undeclared", undefined)).toBeNull();
    expect(evidenceScopeViolation("diff-read", undefined)).toBeNull();
  });

  test("test-run / test-run+mutation REQUIRE a non-empty locus", () => {
    expect(evidenceScopeViolation("test-run", undefined)).toContain("--evidence-locus");
    expect(evidenceScopeViolation("test-run", "  ")).toContain("--evidence-locus"); // whitespace-only is absent
    expect(evidenceScopeViolation("test-run+mutation", null)).toContain("--evidence-locus");
    expect(evidenceScopeViolation("test-run", "~/maw-js-kobo501")).toBeNull();
  });
});

describe("kobo-501 sameEvidenceLocusBothTiers (pure)", () => {
  test("same locus both tiers → the locus; distinct/single/absent → null", () => {
    expect(sameEvidenceLocusBothTiers({ crewSignedEvidenceLocus: "wt-A", headSignedEvidenceLocus: "wt-A" } as any)).toBe("wt-A");
    expect(sameEvidenceLocusBothTiers({ crewSignedEvidenceLocus: "wt-A", headSignedEvidenceLocus: "wt-B" } as any)).toBeNull();
    expect(sameEvidenceLocusBothTiers({ headSignedEvidenceLocus: "wt-A" } as any)).toBeNull(); // single-tier
    expect(sameEvidenceLocusBothTiers({} as any)).toBeNull();
  });
});

describe("kobo-501 formatSignEvidenceScope (pure)", () => {
  test("each scope gets a DISTINCT label, undeclared for both undeclared and undefined", () => {
    const labels = [
      formatSignEvidenceScope("undeclared"),
      formatSignEvidenceScope(undefined),
      formatSignEvidenceScope("diff-read"),
      formatSignEvidenceScope("test-run"),
      formatSignEvidenceScope("test-run+mutation"),
    ];
    expect(labels[0]).toBe(labels[1]); // undeclared === undefined, same honest-unknown label
    expect(new Set(labels).size).toBe(4); // 5 calls, 4 distinct labels (0 and 1 collapse on purpose)
  });
});

describe("kobo-501 signTask store fn: default evidenceScope (independent of the CLI's own default)", () => {
  test("signTask called directly with no evidenceScope arg → 'undeclared', NOT 'diff-read'", () => {
    // the CLI already defaults omitted --evidence to "undeclared" before calling signTask
    // (proven in the CLI describe block below) — this test exercises signTask's OWN
    // fallback directly, for any caller that reaches the store without going through the
    // CLI's default (a future verb, a script, a test helper).
    addTask({ company: "kobo", title: "c", by: "eq3" });
    const t = signTask("kobo", "kobo-1", "patchwork", "head")!;
    expect(t.headSignedEvidenceScope).toBe("undeclared");
  });
});

describe("kobo-501 sign CLI: --evidence / --evidence-locus", () => {
  test("omitting --evidence records 'undeclared', NOT 'diff-read' (the whole point of the card)", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]); // kobo-557: sign now requires a linked PR to bind a SHA
    await signAs("eq3", "kobo-1", "head");
    expect(readTask("kobo", "kobo-1")!.headSignedEvidenceScope).toBe("undeclared");
  });

  test("--evidence diff-read needs no locus", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]); // kobo-557: sign now requires a linked PR to bind a SHA
    const r = await run(["sign", "kobo-1", "--role", "head", "--evidence", "diff-read", "--company", "kobo", "--from", "local:eq3"]);
    expect(r.ok).toBe(true);
    expect(readTask("kobo", "kobo-1")!.headSignedEvidenceScope).toBe("diff-read");
  });

  test("--evidence test-run WITHOUT --evidence-locus is REFUSED, records nothing", async () => {
    await task(["add", "c"]);
    const r = await run(["sign", "kobo-1", "--role", "head", "--evidence", "test-run", "--company", "kobo", "--from", "local:eq3"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--evidence-locus");
    expect(readTask("kobo", "kobo-1")!.headSignedEvidenceScope).toBeUndefined(); // bad state never recorded
  });

  test("--evidence test-run+mutation WITH --evidence-locus records both fields", async () => {
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]); // kobo-557: sign now requires a linked PR to bind a SHA
    const r = await run(["sign", "kobo-1", "--role", "head", "--evidence", "test-run+mutation", "--evidence-locus", "~/maw-js-kobo501", "--company", "kobo", "--from", "local:eq3"]);
    expect(r.ok).toBe(true);
    const t = readTask("kobo", "kobo-1")!;
    expect(t.headSignedEvidenceScope).toBe("test-run+mutation");
    expect(t.headSignedEvidenceLocus).toBe("~/maw-js-kobo501");
  });

  test("an unrecognized --evidence value is refused with a usage error, not silently accepted", async () => {
    await task(["add", "c"]);
    const r = await run(["sign", "kobo-1", "--role", "head", "--evidence", "vibes", "--company", "kobo", "--from", "local:eq3"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--evidence must be one of");
  });
});

describe("kobo-501 merge REFUSE: both tiers cite the same evidence locus (the real kobo-482 shape)", () => {
  test("same locus on both tiers → merge refused, names the locus", async () => {
    // force the same-locus state directly via the store (bypass the CLI, same trick the
    // 336 distinct-signers backstop test above uses) to prove merge independently catches
    // it even if a future caller reaches signTask some other way.
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", null, undefined, "test-run+mutation", "wt-SHARED");
    signTask("kobo", "kobo-1", "eq3", "head", null, undefined, "test-run+mutation", "wt-SHARED");
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("wt-SHARED");
    expect(r.error).toContain("same evidence locus");
  });

  test("distinct loci on both tiers → merge passes this gate (no over-block)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", null, undefined, "test-run", "wt-CREW");
    signTask("kobo", "kobo-1", "eq3", "head", null, undefined, "test-run", "wt-HEAD");
    const r = await task(["merge", "kobo-1", "--method", "octopus"]);
    expect(r.error).toContain("--method"); // reached method check = past the evidence-locus gate
    expect(r.error).not.toContain("same evidence locus");
  });

  test("undeclared/diff-read on both tiers (no locus at all) never over-blocks (both loci absent → guard inert)", async () => {
    await task(["add", "c", "--crew-gate"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew"); // undeclared, no locus
    signTask("kobo", "kobo-1", "eq3", "head"); // undeclared, no locus
    const r = await task(["merge", "kobo-1", "--method", "octopus"]);
    expect(r.error).not.toContain("same evidence locus");
  });
});

describe("kobo-327 merge-gate: web route exposes sign state (Board Truth #7)", () => {
  test("toCard maps crewGate + sign fields so the board UI matches the CLI", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/core/tasks/route.ts"), "utf8");
    expect(src).toContain("crewGate?: boolean"); // TaskCard field
    expect(src).toContain("card.crewGate = true");
    expect(src).toContain("card.crewSignedBy");
    expect(src).toContain("card.headSignedBy");
  });
});

// kobo-578 — overwriting an existing sign never refuses (4 legit re-signs
// happened tonight already: 508/538/546/557), but it never happens silently
// either. Two mechanisms: (1) signHistory — Nothing is Deleted, the sign about
// to be replaced is snapshotted first (2) isSignDowngrade — a re-sign at the
// SAME reviewed content (patch-id unchanged) with WEAKER evidence than what it
// replaced gets flagged loudly. The unit is patch-id, NOT sha — corrected
// mid-design because SHA moves when a sibling PR merges underneath with ZERO
// diff change, which is exactly what happened to kobo-557 tonight
// (ae80e699 → 36d7e5aa → 4a3548fb, same content, twice) — a sha-keyed
// mechanism would have flagged both of THOSE re-signs as false-positive
// downgrades, training everyone to ignore the real warning when it fires.
describe("kobo-578 signHistory + patch-id downgrade detection", () => {
  // the outer beforeEach only clears companies/kobo/tasks — worklog.jsonl is a
  // sibling file it never touches, and several tests here assert EXACT
  // task-sign-downgrade counts, so leftover events from an earlier test in
  // this block (same kobo-1 id, reused every test) would false-positive.
  // readWorklog caches by file size — a plain rmSync alone isn't enough if a
  // deleted-then-rewritten file happens to land back on the SAME size, so
  // reset the cache too (store.test.ts's own established pattern).
  beforeEach(() => {
    rmSync(worklogPath("kobo"), { force: true });
    _resetWorklogCache();
  });

  test("re-signing a tier snapshots the PRIOR sign into signHistory before overwriting — nothing lost", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "patchwork", "head", null, "sha-1", "test-run", "loc-1", "patch-1");
    const t = signTask("kobo", "kobo-1", "eq3", "head", null, "sha-2", "diff-read", undefined, "patch-2")!;
    // current fields reflect the SECOND sign
    expect(t.headSignedBy).toBe("eq3");
    expect(t.headSignedSha).toBe("sha-2");
    expect(t.headSignedEvidenceScope).toBe("diff-read");
    // the FIRST sign is preserved, not erased
    expect(t.signHistory?.length).toBe(1);
    expect(t.signHistory![0]).toMatchObject({
      role: "head", by: "patchwork", sha: "sha-1", patchId: "patch-1", evidenceScope: "test-run", evidenceLocus: "loc-1",
    });
  });

  test("signHistory accumulates across multiple re-signs of the SAME tier, oldest first", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "a", "head", null, "sha-1", "undeclared", undefined, "patch-1");
    signTask("kobo", "kobo-1", "b", "head", null, "sha-2", "diff-read", undefined, "patch-2");
    const t = signTask("kobo", "kobo-1", "c", "head", null, "sha-3", "test-run", "loc-3", "patch-3")!;
    expect(t.signHistory?.map((h) => h.by)).toEqual(["a", "b"]);
    expect(t.headSignedBy).toBe("c"); // only the current pointer moved, history is append-only
  });

  test("a first-ever sign on a tier has no prior — signHistory stays empty", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    const t = signTask("kobo", "kobo-1", "patchwork", "crew", null, "sha-1", "diff-read", undefined, "patch-1")!;
    expect(t.signHistory ?? []).toEqual([]);
  });

  test("re-signing at the SAME patch-id with WEAKER evidence → downgrade (isSignDowngrade fires, distinct worklog kind emitted)", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "patchwork", "head", null, "sha-1", "test-run+mutation", "loc-1", "patch-SAME");
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-2", "diff-read", undefined, "patch-SAME"); // same content, weaker claim
    const wl = readWorklog("kobo");
    const downgradeEvent = wl.find((e) => e.kind === "task-sign-downgrade" && e.task === "kobo-1");
    expect(downgradeEvent).toBeTruthy();
    expect(String((downgradeEvent as any).summary)).toContain("DOWNGRADE");
  });

  // The exact live shape from kobo-557 tonight: ancestry moved TWICE (a sibling
  // PR merging underneath) while the reviewed diff never changed a single line.
  // A sha-keyed mechanism would call this a downgrade at EVERY step even when
  // evidence stayed constant or improved — the false-positive this design
  // explicitly avoids by keying on patch-id instead.
  test("kobo-557-shaped case: sha changes twice, patch-id constant, evidence UNCHANGED → never flagged a downgrade", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "reviewer", "crew", null, "ae80e699", "test-run+mutation", "loc-1", "patch-557");
    signTask("kobo", "kobo-1", "reviewer", "crew", null, "36d7e5aa", "test-run+mutation", "loc-1", "patch-557"); // ancestry moved, re-signed same content
    signTask("kobo", "kobo-1", "reviewer", "crew", null, "4a3548fb", "test-run+mutation", "loc-1", "patch-557"); // ancestry moved again
    const wl = readWorklog("kobo");
    const downgrades = wl.filter((e) => e.kind === "task-sign-downgrade" && e.task === "kobo-1");
    expect(downgrades.length).toBe(0); // sha moved twice, content didn't — never a downgrade
  });

  test("kobo-557-shaped case, but evidence ALSO weakens at the constant patch-id → THAT is correctly flagged", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "reviewer", "crew", null, "ae80e699", "test-run+mutation", "loc-1", "patch-557");
    signTask("kobo", "kobo-1", "reviewer", "crew", null, "36d7e5aa", "diff-read", undefined, "patch-557"); // same content, weaker claim this time
    const wl = readWorklog("kobo");
    const downgrades = wl.filter((e) => e.kind === "task-sign-downgrade" && e.task === "kobo-1");
    expect(downgrades.length).toBe(1);
  });

  test("patch-id UNKNOWN on either side → never assumed same or different, no downgrade claim either way", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "patchwork", "head", null, "sha-1", "test-run+mutation", "loc-1"); // no patch-id fetched (gh failure, best-effort)
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-2", "diff-read"); // also no patch-id
    const wl = readWorklog("kobo");
    expect(wl.filter((e) => e.kind === "task-sign-downgrade" && e.task === "kobo-1").length).toBe(0);
  });

  // kobo-578 review round 1 — the false-positive direction, undeclared/untested
  // until now: a re-sign with WEAKER evidence at a genuinely DIFFERENT patch-id
  // (real code change — the 4-times-a-day shape this card explicitly protects,
  // "re-signed because the code changed") must NOT be flagged, since the old
  // evidence is simply moot, not replaced-by-something-worse. Reviewer's own
  // undeclared mutation (removing the `prior.patchId !== newPatchId` early
  // return) turned this exact case into a false DOWNGRADE — this pins it.
  test("different patch-id (real content change) + weaker evidence → NOT a downgrade, evidence is just moot", () => {
    addTask({ company: "kobo", title: "c", by: "eq3" });
    signTask("kobo", "kobo-1", "patchwork", "head", null, "sha-1", "test-run+mutation", "loc-1", "patch-A");
    signTask("kobo", "kobo-1", "eq3", "head", null, "sha-2", "diff-read", undefined, "patch-B"); // real code change, weaker claim on the NEW code
    const wl = readWorklog("kobo");
    expect(wl.filter((e) => e.kind === "task-sign-downgrade" && e.task === "kobo-1").length).toBe(0);
  });

  test("sign CLI prints an overwrite notice on ANY re-sign of an already-signed tier, downgrade or not", async () => {
    await task(["add", "c"]);
    // a merged sibling PR (landed on alpha since this branch forked) now refuses
    // sign with no PR linked — link one first, same pattern the rest of this file uses.
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await signAs("eq3", "kobo-1", "head");
    const r = await signAs("patchwork", "kobo-1", "head");
    expect(r.output).toContain("overwriting existing head sign");
    expect(r.output).toContain("eq3"); // names the PRIOR signer
  });

  test("sign-history <id> lists prior signs, oldest first; empty card says so plainly", async () => {
    await task(["add", "c"]);
    const empty = await run(["sign-history", "kobo-1", "--company", "kobo", "--from", "local:eq3"]);
    expect(empty.output).toContain("no sign history");

    // a merged sibling PR (landed on alpha since this branch forked) now refuses
    // sign with no PR linked — link one first, same pattern the rest of this file uses.
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await signAs("eq3", "kobo-1", "head");
    await signAs("patchwork", "kobo-1", "head");
    const r = await run(["sign-history", "kobo-1", "--company", "kobo", "--from", "local:eq3"]);
    expect(r.output).toContain("head");
    expect(r.output).toContain("eq3"); // the superseded signer shows up
  });
});
