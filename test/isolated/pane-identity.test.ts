import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import { addTask, readTask, signTask, samePaneBothTiers, signPaneViolation } from "../../src/core/tasks/store";

// kobo-346 (v2 340c): bind a sign to the SIGNING PANE. A v2 crew is "N panes, 1 soul" — reviewer,
// worker, lead panes all resolve to ONE oracle, so kobo-336's oracle-distinct check can't catch an
// intra-oracle phantom-sign (kobo-339: a non-reviewer pane signs a tier). Two guards:
//   item-4 (real 339 closer): a sign must come from the designated reviewer pane (CREW_ROLE=reviewer).
//   item-3 (belt): the two tiers must come from DISTINCT panes.
// CEILING: pane-id + CREW_ROLE are live-resolved in the signer's own shell → agent-settable →
// DEFENSE-IN-DEPTH, NOT airtight (no "unforgeable" claim).

// ── pure logic (deterministic, no tmux) — the 3 head-mandated tests + fallbacks ──
describe("kobo-346 signPaneViolation (pure)", () => {
  const card = (over: object = {}) => ({ crewSignedByPane: undefined, headSignedByPane: undefined, ...over }) as any;

  test("[test 3] legit reviewer pane sign → PASS (null)", () => {
    expect(signPaneViolation(card(), "crew", "%12", "reviewer")).toBeNull();
    expect(signPaneViolation(card({ crewSignedByPane: "%12" }), "head", "%13", "reviewer")).toBeNull(); // distinct pane, reviewer
  });

  test("[test 2 — the real 339 fix] head-sign from a NON-reviewer pane → REFUSE", () => {
    expect(signPaneViolation(card(), "head", "%99", "worker")).toContain("reviewer pane"); // worker pane
    expect(signPaneViolation(card(), "head", "%0", "")).toContain("reviewer pane");        // lead/coord (no role)
    expect(signPaneViolation(card(), "head", "%0", "coord")).toContain("reviewer pane");
  });

  test("[test 1] same pane both tiers → REFUSE (distinct-pane rule)", () => {
    // reviewer pane %12 already crew-signed; the SAME pane tries to head-sign
    expect(signPaneViolation(card({ crewSignedByPane: "%12" }), "head", "%12", "reviewer")).toContain("already signed");
  });

  test("no pane binding (not a tmux pane) → null → falls back to oracle-grain (kobo-335)", () => {
    expect(signPaneViolation(card(), "head", null, "worker")).toBeNull();
    expect(signPaneViolation(card(), "head", undefined, undefined)).toBeNull();
  });
});

describe("kobo-346 samePaneBothTiers (merge backstop, pure)", () => {
  test("same pane both tiers → the pane; distinct / missing → null", () => {
    expect(samePaneBothTiers({ crewSignedByPane: "%12", headSignedByPane: "%12" } as any)).toBe("%12");
    expect(samePaneBothTiers({ crewSignedByPane: "%12", headSignedByPane: "%13" } as any)).toBeNull();
    expect(samePaneBothTiers({ headSignedByPane: "%12" } as any)).toBeNull(); // no crew pane
    expect(samePaneBothTiers({} as any)).toBeNull();
  });
});

// ── wiring: signTask records the pane; merge refuses same-pane both tiers ──
describe("kobo-346 sign records pane + merge pane-backstop (runTask)", () => {
  const dir = mkdtempSync(join(tmpdir(), "maw-pane-"));
  const prev = process.env.MAW_DATA_DIR, prevAgent = process.env.CLAUDE_AGENT_NAME, prevTest = process.env.MAW_TEST_MODE, prevTmux = process.env.TMUX;
  beforeAll(() => {
    process.env.MAW_DATA_DIR = dir; process.env.CLAUDE_AGENT_NAME = "eq3"; process.env.MAW_TEST_MODE = "1";
    delete process.env.TMUX; // no pane binding here → drive panes via signTask() directly, deterministic
    mkdirSync(join(dir, "companies"), { recursive: true });
    writeFileSync(join(dir, "companies", "kobo.json"), JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "eq3" }, { oracle: "patchwork" }], lead: "eq3" } } }));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev;
    if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
    if (prevTest === undefined) delete process.env.MAW_TEST_MODE; else process.env.MAW_TEST_MODE = prevTest;
    if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => rmSync(join(dir, "companies", "kobo", "tasks"), { recursive: true, force: true }));
  const task = (args: string[]) => runTask([...args, "--company", "kobo", "--from", "local:eq3"], () => {});

  test("signTask records the signing pane on the tier", () => {
    addTask({ company: "kobo", title: "c", by: "eq3", crewGate: true });
    signTask("kobo", "kobo-1", "patchwork", "crew", "%12");
    expect(readTask("kobo", "kobo-1")!.crewSignedByPane).toBe("%12");
  });

  test("merge REFUSES when one pane signed BOTH tiers (kobo-339 backstop)", async () => {
    addTask({ company: "kobo", title: "c", by: "eq3", crewGate: true });
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    // distinct oracles (passes 336) but SAME pane %12 → 346 backstop must catch it
    signTask("kobo", "kobo-1", "patchwork", "crew", "%12");
    signTask("kobo", "kobo-1", "mawjs", "head", "%12");
    const r = await task(["merge", "kobo-1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pane %12 signed BOTH");
  });

  test("distinct panes → merge passes the pane-gate (lands on method-validation, no gh)", async () => {
    addTask({ company: "kobo", title: "c", by: "eq3", crewGate: true });
    await task(["pr", "kobo-1", "42", "--repo", "meganechan/maw-js"]);
    signTask("kobo", "kobo-1", "patchwork", "crew", "%12");
    signTask("kobo", "kobo-1", "eq3", "head", "%13"); // distinct pane + distinct oracle
    const r = await task(["merge", "kobo-1", "--method", "octopus"]); // method check is AFTER the sign gates
    expect(r.error).toContain("--method");        // reached method validation = past 336 + 346
    expect(r.error).not.toContain("signed BOTH");
  });
});
