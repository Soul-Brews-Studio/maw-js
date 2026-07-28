import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Integration test for the Track 3 hook — drives the REAL routeComm("hey", …)
// command path (not autoCreateFromDispatch directly), with delivery stubbed, and
// asserts a board card appears. This is the gap that let #50 pass unit-green
// while the live `maw hey [request:]` created nothing: cmdSend process.exit()s on
// many delivery outcomes, so a hook placed AFTER it never ran. The card must be
// recorded BEFORE delivery — including when delivery then throws/exits.

const calls: unknown[][] = [];
let cmdSendImpl: (...a: unknown[]) => Promise<void> = async (...a) => { calls.push(a); };
// Spread the real barrel so static re-exports (resolvePeekTarget, …) still link;
// only cmdSend is overridden.
const actualComm = await import("../../src/commands/shared/comm");
mock.module("../../src/commands/shared/comm", () => ({
  ...actualComm,
  cmdSend: (...args: unknown[]) => cmdSendImpl(...args),
}));

const dir = mkdtempSync(join(tmpdir(), "maw-rcac-"));
const prev = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevTest = process.env.MAW_TEST_MODE;
process.env.MAW_DATA_DIR = dir; // set BEFORE importing (company-helpers caches COMPANIES_DIR at load)
// kobo-335: CLAUDE_AGENT_NAME + MAW_TEST_MODE are set in beforeAll (NOT here) — read at call-time,
// and a top-level mutation would bleed into other test files loaded in the same batch. cmdSend is
// already mocked (above); MAW_TEST_MODE additionally suppresses the notify.ts ping spawn that
// auto-create / mention-capture would otherwise fire at a live pane.

const { routeComm } = await import("../../src/cli/route-comm");
const { listTasks, addTask, readTask } = await import("../../src/core/tasks/store");

function seedCompany() {
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({
      name: "kobo",
      departments: { core: { members: [{ oracle: "eq3", role: "lead" }, { oracle: "patchwork", role: "dev" }], lead: "eq3" } },
    }),
  );
}

beforeAll(() => { process.env.CLAUDE_AGENT_NAME = "eq3"; process.env.MAW_TEST_MODE = "1"; seedCompany(); }); // kobo-335: dispatcher=eq3 (binds --from) + suppress live-pane notify
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = prevTest;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  cmdSendImpl = async (...a) => { calls.push(a); };
  rmSync(join(dir, "companies", "kobo"), { recursive: true, force: true });
  rmSync(join(dir, "companies", "web3"), { recursive: true, force: true });
});

describe("routeComm hey → auto-create board card (Track 3 integration)", () => {
  test("`maw hey --from local:eq3 patchwork [request:..]` creates a kobo card", async () => {
    const handled = await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "[request:repro-1] do the thing"]);
    expect(handled).toBe(true);
    expect(calls.length).toBe(1); // delivery still happened
    const tasks = listTasks("kobo");
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({
      requestId: "repro-1",
      by: "eq3",
      assignee: "patchwork",
      state: "in-progress",
      title: "do the thing",
    });
  });

  test("REGRESSION (#50): card is created even when delivery exits/throws", async () => {
    // cmdSend process.exit()s in the live binary; emulate the abort with a throw.
    cmdSendImpl = async () => { throw new Error("delivery aborted (process.exit emulation)"); };
    await expect(
      routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "[request:exit-1] survives delivery abort"]),
    ).rejects.toThrow(); // delivery still fails loudly…
    // …but the card was recorded BEFORE delivery, so it exists regardless.
    const tasks = listTasks("kobo");
    expect(tasks.length).toBe(1);
    expect(tasks[0].requestId).toBe("exit-1");
  });

  test("idempotent — re-send same request creates no second card", async () => {
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "[request:dup-1] x"]);
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "[request:dup-1] x"]);
    expect(listTasks("kobo").filter((t) => t.requestId === "dup-1").length).toBe(1);
  });

  test("normal hey (no [request:]) creates no card; delivery still happens", async () => {
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "just a normal message"]);
    expect(listTasks("kobo")).toEqual([]);
    expect(calls.length).toBe(1);
  });

  // kobo-555 follow-up (eq3 head review, crew reviewer independently raised the same
  // gap): the auto-capture removal made this file's coverage of route-comm.ts:185's
  // authenticateActor call site MORE VISIBLE, not less real — it was already the only
  // gate standing between a forged --from and an auto-created card's `by` field
  // (kobo-335). Nothing here previously pinned the CALL SITE directly; the harness
  // agent-self is "eq3" (beforeAll), so a claim of "patchwork" is a forgery.
  test("a FORGED --from on a [request:] dispatch creates NO card (authenticateActor refuses, kobo-335)", async () => {
    const handled = await routeComm("hey", ["hey", "--from", "local:patchwork", "patchwork", "[request:forge-2] forged dispatch"]);
    expect(handled).toBe(true);
    expect(calls.length).toBe(1); // delivery itself is unaffected — auth only gates the auto-create
    expect(listTasks("kobo").filter((t) => t.requestId === "forge-2")).toEqual([]);
  });
});

// kobo-555: kobo-165's auto-capture (a hey mentioning an existing card id wrote
// the message onto it as a note) is REMOVED — dispatch no longer travels by hey
// (Board Truth rule 2, "dispatch = card"), so the net this feature caught was
// only ever chatter. These tests are FLIPPED from "a note appears" to "no note
// appears" (not deleted) per the card's own instruction: deleting them outright
// would silently drop coverage of the new behavior. The forged-actor and
// task-events-channel edge cases from the old suite tested GATES on the capture
// mechanism itself; with the mechanism gone there is no gate left to test, so
// they are not carried forward (kept: the general "no note ever" case and the
// digit-suffix-company case, both still meaningful as regression guards).
describe("routeComm hey → NO auto-capture note (kobo-555, kobo-165 removed)", () => {
  test("a hey referencing an existing card does NOT append a note; delivery still happens", async () => {
    const card = addTask({ company: "kobo", title: "seed", by: "eq3", assignee: "patchwork", state: "todo" });
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", `ping about ${card.id} — รอ review`]);
    expect(calls.length).toBe(1); // delivery still happens
    const after = readTask("kobo", card.id)!;
    expect(after.notes ?? []).toEqual([]); // no auto-capture note
  });

  test("digit-suffix company card mention also creates no note (web3-1, kobo-555)", async () => {
    const card = addTask({ company: "web3", title: "seed3", by: "eq3", assignee: "patchwork", state: "todo" });
    expect(card.id).toBe("web3-1");
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", `heads up on ${card.id}`]);
    expect(calls.length).toBe(1); // delivery still happens
    expect(readTask("web3", card.id)!.notes ?? []).toEqual([]);
  });

  test("references an unknown card → no note, delivery still happens", async () => {
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "look at kobo-999 pls"]);
    expect(calls.length).toBe(1);
    expect(readTask("kobo", "kobo-999")).toBeNull();
  });
});
