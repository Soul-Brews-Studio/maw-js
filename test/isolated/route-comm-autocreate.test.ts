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
process.env.MAW_DATA_DIR = dir; // set BEFORE importing (company-helpers caches COMPANIES_DIR at load)

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

beforeAll(seedCompany);
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
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
});

describe("routeComm hey → auto-capture card mention as note (kobo-165)", () => {
  test("a hey referencing an existing card appends a [via hey] note; delivery still happens", async () => {
    const card = addTask({ company: "kobo", title: "seed", by: "eq3", assignee: "patchwork", state: "todo" });
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", `ping about ${card.id} — รอ review`]);
    expect(calls.length).toBe(1); // delivery not blocked by capture
    const after = readTask("kobo", card.id)!;
    expect(after.notes?.length).toBe(1);
    expect(after.notes![0].by).toBe("eq3");
    expect(after.notes![0].text).toContain("[via hey→patchwork]");
    expect(after.notes![0].text).toContain(card.id);
  });

  test("anti-loop: a task-events channel ping is NOT captured", async () => {
    const card = addTask({ company: "kobo", title: "seed2", by: "eq3", assignee: "patchwork", state: "todo" });
    await routeComm("hey", [
      "hey", "--from", "local:eq3", "--channel", "task-events", "patchwork",
      `[task] eq3 commented on ${card.id}: hi`,
    ]);
    expect(readTask("kobo", card.id)!.notes ?? []).toEqual([]);
  });

  test("gate does not drop a digit-suffix company (web3-1 captured, regression)", async () => {
    const card = addTask({ company: "web3", title: "seed3", by: "eq3", assignee: "patchwork", state: "todo" });
    expect(card.id).toBe("web3-1"); // company name ends in a digit — old gate /[a-z]-\d/ would skip
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", `heads up on ${card.id}`]);
    const after = readTask("web3", card.id)!;
    expect(after.notes?.length).toBe(1);
    expect(after.notes![0].text).toContain("[via hey→patchwork]");
  });

  test("references an unknown card → no note, delivery still happens", async () => {
    await routeComm("hey", ["hey", "--from", "local:eq3", "patchwork", "look at kobo-999 pls"]);
    expect(calls.length).toBe(1);
    expect(readTask("kobo", "kobo-999")).toBeNull();
  });
});
