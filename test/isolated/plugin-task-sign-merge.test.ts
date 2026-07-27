import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import {
  addTask,
  readTask,
  requiredSignTiers,
  missingSignTiers,
  sameSignerBothTiers,
  signTask,
} from "../../src/core/tasks/store";

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
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = prevTest;
  if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
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
    const c = await signAs("eq3", "kobo-1", "crew");
    expect(c.ok).toBe(true);
    expect(c.output).toContain("still needs: head");
    const h = await signAs("patchwork", "kobo-1", "head"); // kobo-336: distinct signer for head
    expect(h.output).toContain("mergeable");
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

  test("sign-time SHA capture is skipped under MAW_TEST_MODE (never shells to real gh in tests)", async () => {
    // process.env.MAW_TEST_MODE is already "1" for this whole file (see beforeAll above).
    // A real `sign` through the CLI, with a PR linked, must NOT populate *SignedSha —
    // otherwise every sign-related test in this file would be making live gh calls.
    await task(["add", "c"]);
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    await signAs("eq3", "kobo-1", "head");
    expect(readTask("kobo", "kobo-1")!.headSignedSha).toBeUndefined();
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
