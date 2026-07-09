import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import { listArchivedTasks, listTasks, readTask } from "../../src/core/tasks/store";

// Behavioural test for the task-board runner `runTask` — the shared engine that
// `maw company task` (and the maw_task MCP tool) drive. cli-reorg kobo-26 removed
// the top-level `maw task` command, so we exercise the runner directly (no
// default handler). No --assignee is used, so no ping ever fires — hermetic.

const dir = mkdtempSync(join(tmpdir(), "maw-taskcli-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

// Collect emitted lines into `output` so the same assertions (output/ok/error) hold.
const run = async (args: string[]): Promise<{ ok: boolean; error?: string; output: string }> => {
  const out: string[] = [];
  const r = await runTask(args, (l) => out.push(l));
  return { ...r, output: out.join("\n") };
};

describe("maw company task runner (runTask)", () => {
  test("add stores ONLY the title — flag values never leak into it (regression)", async () => {
    const r = await run(["add", "ship the board", "--company", "pgw", "--dept", "core", "--epic", "kanban"]);
    expect(r.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.title).toBe("ship the board");
    expect(t.dept).toBe("core");
    expect(t.epic).toBe("kanban");
    expect(t.state).toBe("todo");
  });

  test("claim then done move the card through states", async () => {
    await run(["add", "task one", "--company", "pgw"]);
    expect((await run(["claim", "pgw-1", "--company", "pgw"])).ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.state).toBe("in-progress");
    expect((await run(["done", "pgw-1", "--company", "pgw"])).ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.state).toBe("done");
  });

  test("edit --reviewer amends the reviewer in place; combinable with --title; old reviewer audited (kobo-214)", async () => {
    await run(["add", "card", "--company", "pgw", "--from", "eq3", "--reviewer", "eq3"]);
    const r = await run(["edit", "pgw-1", "--reviewer", "worker", "--title", "card v2", "--company", "pgw", "--from", "tony"]);
    expect(r.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.reviewer).toBe("worker"); // reviewer amended
    expect(t.title).toBe("card v2"); // combinable with --title
    expect(t.notes!.at(-1)!.text).toContain("reviewer was: eq3"); // Nothing Deleted
  });

  test("edit with no editable fields → usage error naming --reviewer (kobo-214)", async () => {
    await run(["add", "card", "--company", "pgw"]);
    const r = await run(["edit", "pgw-1", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--reviewer");
  });

  test("ls --mine filters to the caller's assigned cards", async () => {
    await run(["add", "unassigned", "--company", "pgw"]);
    await run(["add", "mine", "--company", "pgw"]);
    await run(["claim", "pgw-2", "--company", "pgw"]); // caller claims pgw-2
    const all = await run(["ls", "--company", "pgw"]);
    const mine = await run(["ls", "--company", "pgw", "--mine"]);
    expect(all.output).toContain("unassigned");
    expect(mine.output).toContain("mine");
    expect(mine.output).not.toContain("unassigned");
  });

  test("archive <id> moves ONE card off the board into archive/ (kobo-35)", async () => {
    await run(["add", "keep me", "--company", "pgw"]);       // pgw-1
    await run(["add", "review me", "--company", "pgw"]);     // pgw-2
    await run(["done", "pgw-2", "--company", "pgw"]);
    const r = await run(["archive", "pgw-2", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("archived");
    expect(r.output).toContain("pgw-2");
    // gone from the active store, preserved in archive/ (principle 1) — never deleted
    expect(readTask("pgw", "pgw-2")).toBeNull();
    expect(listTasks("pgw").map((t) => t.id)).toEqual(["pgw-1"]);
    expect(listArchivedTasks("pgw").map((t) => t.id)).toContain("pgw-2");
  });

  test("archive <id> for a missing card → clean error, not a throw", async () => {
    const r = await run(["archive", "pgw-999", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  test("archive with no id still runs the bulk --days sweep (unchanged)", async () => {
    await run(["add", "fresh done", "--company", "pgw"]); // pgw-1
    await run(["done", "pgw-1", "--company", "pgw"]);
    const r = await run(["archive", "--company", "pgw"]); // default window — nothing old enough
    expect(r.ok).toBe(true);
    expect(r.output).toContain("nothing to archive");
    expect(readTask("pgw", "pgw-1")!.state).toBe("done"); // recent done stays on the board
  });

  test("add --kind epic marks a container card; default add is a plain task (kobo-72)", async () => {
    expect((await run(["add", "the epic", "--company", "pgw", "--kind", "epic"])).ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.kind).toBe("epic");
    await run(["add", "a task", "--company", "pgw"]); // pgw-2, no --kind
    expect(readTask("pgw", "pgw-2")!.kind).toBeUndefined(); // task is the default (not persisted)
    const bad = await run(["add", "nope", "--company", "pgw", "--kind", "bogus"]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("epic or task");
  });

  test("epic <id> <epicId> sets containment; --clear removes it (kobo-72)", async () => {
    await run(["add", "parent epic", "--company", "pgw", "--kind", "epic"]); // pgw-1
    await run(["add", "child", "--company", "pgw"]);                          // pgw-2
    const set = await run(["epic", "pgw-2", "pgw-1", "--company", "pgw"]);
    expect(set.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")!.epic).toBe("pgw-1");
    const clr = await run(["epic", "pgw-2", "--clear", "--company", "pgw"]);
    expect(clr.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")!.epic).toBeUndefined();
  });

  test("epic re-links a same-id dependency onto containment (the hand-edit gap, kobo-72)", async () => {
    await run(["add", "epic", "--company", "pgw", "--kind", "epic"]);              // pgw-1
    await run(["add", "child", "--company", "pgw", "--parent", "pgw-1"]);          // pgw-2 wrongly dep'd on pgw-1
    expect(readTask("pgw", "pgw-2")!.parentIds).toEqual(["pgw-1"]);
    await run(["epic", "pgw-2", "pgw-1", "--company", "pgw"]);
    const t = readTask("pgw", "pgw-2")!;
    expect(t.epic).toBe("pgw-1");
    expect(t.parentIds).toBeUndefined(); // stale dep on the same id dropped
  });

  test("dep add/rm edit parentIds after create; guards + usage errors are clean (kobo-134)", async () => {
    await run(["add", "parent", "--company", "pgw"]); // pgw-1
    await run(["add", "child", "--company", "pgw"]);  // pgw-2
    const add = await run(["dep", "add", "pgw-2", "pgw-1", "--company", "pgw"]);
    expect(add.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")!.parentIds).toEqual(["pgw-1"]);
    // reverse link = wait cycle → clean error, not a throw
    const loop = await run(["dep", "add", "pgw-1", "pgw-2", "--company", "pgw"]);
    expect(loop.ok).toBe(false);
    expect(loop.error).toMatch(/loop/i);
    const rm = await run(["dep", "rm", "pgw-2", "pgw-1", "--company", "pgw"]);
    expect(rm.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")!.parentIds).toBeUndefined();
    expect((await run(["dep", "bogus", "pgw-2", "pgw-1", "--company", "pgw"])).error).toContain("usage");
    expect((await run(["dep", "add", "pgw-2", "--company", "pgw"])).error).toContain("usage");
    expect((await run(["dep", "add", "pgw-999", "pgw-1", "--company", "pgw"])).error).toContain("not found");
  });

  test("dep add warns (still links) when the parent id resolves to nothing (kobo-134)", async () => {
    await run(["add", "child", "--company", "pgw"]); // pgw-1
    const r = await run(["dep", "add", "pgw-1", "pgw-ghost", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.parentIds).toEqual(["pgw-ghost"]);
    expect(r.output).toContain("ไม่พบ");
  });

  test("epic rejects a containment loop; usage/not-found errors are clean (kobo-72)", async () => {
    await run(["add", "a", "--company", "pgw"]); // pgw-1
    await run(["add", "b", "--company", "pgw"]); // pgw-2
    await run(["epic", "pgw-2", "pgw-1", "--company", "pgw"]); // b under a
    const loop = await run(["epic", "pgw-1", "pgw-2", "--company", "pgw"]); // a under b → cycle
    expect(loop.ok).toBe(false);
    expect(loop.error).toMatch(/loop/i);
    expect((await run(["epic", "pgw-1", "--company", "pgw"])).error).toContain("usage"); // no epicId, no --clear
    expect((await run(["epic", "pgw-999", "pgw-1", "--company", "pgw"])).error).toContain("not found");
  });

  test("pr links a card + stamps repo from the PR url; --repo overrides (kobo-80)", async () => {
    await run(["add", "url card", "--company", "pgw"]); // pgw-1, no repo
    const r = await run(["pr", "pgw-1", "https://github.com/meganechan/maw-js/pull/106", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.pr).toBe(106);
    expect(t.repo).toBe("meganechan/maw-js"); // stamped from the url → pr-watch can now poll it
    expect(t.state).toBe("review");

    await run(["add", "override card", "--company", "pgw"]); // pgw-2
    await run(["pr", "pgw-2", "5", "--repo", "acme/thing", "--company", "pgw"]);
    expect(readTask("pgw", "pgw-2")!.repo).toBe("acme/thing"); // explicit --repo with a bare number
  });

  test("pr WARNs when repo is derived from CWD (bare number, no --repo/url) — kobo-195", async () => {
    // A bare number with no --repo/url falls back to the CWD git remote. That's the
    // kobo-188 foot-gun (stamps the oracle repo, not the target) → WARN loudly.
    await run(["add", "cwd-fallback card", "--company", "pgw"]); // pgw-1
    const r = await run(["pr", "pgw-1", "7", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("repo derived from CWD"); // the warning fired
    expect(readTask("pgw", "pgw-1")!.repo).toBe("meganechan/maw-js"); // this worktree's origin

    // explicit --repo → trusted silently, no warning
    await run(["add", "explicit card", "--company", "pgw"]); // pgw-2
    const r2 = await run(["pr", "pgw-2", "8", "--repo", "acme/thing", "--company", "pgw"]);
    expect(r2.output).not.toContain("repo derived from CWD");
    expect(readTask("pgw", "pgw-2")!.repo).toBe("acme/thing");
  });

  test("pr rejects a bare repo (no owner) — an unpollable link never binds (kobo-99)", async () => {
    await run(["add", "bare repo card", "--company", "pgw"]); // pgw-1
    const r = await run(["pr", "pgw-1", "5", "--repo", "helm-charts", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("owner/name");
    // link rejected → card untouched (no pr, still todo), not silently bound to an
    // unpollable repo that gh pr list would error on
    expect(readTask("pgw", "pgw-1")!.pr).toBeUndefined();
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo");
  });

  test("reject sets state=rejected + stores the reason (kobo-101)", async () => {
    await run(["add", "over-scoped plan", "--company", "pgw"]); // pgw-1
    await run(["claim", "pgw-1", "--company", "pgw"]);          // in-progress
    const r = await run(["reject", "pgw-1", "--reason", "เกิน scope", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("rejected");
    const t = readTask("pgw", "pgw-1")!;
    expect(t.state).toBe("rejected");
    expect(t.rejectReason).toBe("เกิน scope");
  });

  test("reject WITHOUT --reason is refused — reason is mandatory (kobo-101)", async () => {
    await run(["add", "no reason", "--company", "pgw"]); // pgw-1
    const r = await run(["reject", "pgw-1", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--reason is required");
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo"); // untouched
  });

  test("approve routes a reviewed card to approve with a mandatory reason (kobo-191)", async () => {
    await run(["add", "big deploy", "--company", "pgw"]); // pgw-1
    await run(["review", "pgw-1", "--company", "pgw"]);
    const r = await run(["approve", "pgw-1", "--reason", "live migration — needs Tony", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("approve");
    const t = readTask("pgw", "pgw-1")!;
    expect(t.state).toBe("approve");
    expect(t.reviewReason).toBe("live migration — needs Tony"); // Tony sees why in the approve card
  });

  test("approve WITHOUT --reason is refused — the Approve lane never lies (kobo-191)", async () => {
    await run(["add", "no reason approve", "--company", "pgw"]); // pgw-1
    const r = await run(["approve", "pgw-1", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--reason is required");
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo"); // untouched, not parked
  });

  test("need-answer is a STANDALONE verb (mirrors approve) — parks a card in Tony's decision queue (kobo-235)", async () => {
    await run(["add", "which direction", "--company", "pgw"]); // pgw-1
    await run(["start", "pgw-1", "--company", "pgw"]); // in-progress
    const r = await run(["need-answer", "pgw-1", "--reason", "A or B for the schema?", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("need-answer");
    const t = readTask("pgw", "pgw-1")!;
    expect(t.state).toBe("need-answer");
    expect(t.reviewReason).toBe("A or B for the schema?");
  });

  test("need-answer WITHOUT --reason is refused — the decision queue never lies (kobo-235)", async () => {
    await run(["add", "no reason", "--company", "pgw"]); // pgw-1
    const r = await run(["need-answer", "pgw-1", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--reason is required");
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo"); // untouched, not parked
  });

  test("move to approve also requires a reason (no reason-less bypass) (kobo-191)", async () => {
    await run(["add", "bypass attempt", "--company", "pgw"]); // pgw-1
    const noReason = await run(["move", "pgw-1", "approve", "--company", "pgw"]);
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toContain("--reason is required");
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo");
    // with a reason it routes through approveTask → parked + reason recorded
    const ok = await run(["move", "pgw-1", "approve", "--reason", "cross-company change", "--company", "pgw"]);
    expect(ok.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.state).toBe("approve");
    expect(t.reviewReason).toBe("cross-company change");
  });

  test("move to need-answer requires a reason (Tony's decision queue) (kobo-218)", async () => {
    await run(["add", "which way", "--company", "pgw"]); // pgw-1
    const noReason = await run(["move", "pgw-1", "need-answer", "--company", "pgw"]);
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toContain("--reason is required");
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo");
    const ok = await run(["move", "pgw-1", "need-answer", "--reason", "A or B?", "--company", "pgw"]);
    expect(ok.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.state).toBe("need-answer");
    expect(t.reviewReason).toBe("A or B?");
  });

  test("move to a non-approve parking state still needs no reason (kobo-191 regression)", async () => {
    await run(["add", "park me", "--company", "pgw"]); // pgw-1
    const r = await run(["move", "pgw-1", "backlog", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.state).toBe("backlog");
  });

  test("add --state approve CREATES a deploy-approval card into the Approve lane; --reason required (kobo-218)", async () => {
    const noReason = await run(["add", "deploy m5", "--state", "approve", "--company", "pgw"]);
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toContain("--reason is required");
    const ok = await run(["add", "deploy m5", "--state", "approve", "--reason", "restart maw-server", "--company", "pgw"]); // pgw-1
    expect(ok.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.state).toBe("approve");
    expect(t.reviewReason).toBe("restart maw-server"); // carries the WHY
  });

  test("add --state in-progress is still refused (only backlog|todo|approve addable) (kobo-218)", async () => {
    const r = await run(["add", "no direct", "--state", "in-progress", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--state must be backlog, todo or approve");
  });

  test("add --state approve with NO --body PREFILLS the 9-section template (kobo-222)", async () => {
    const ok = await run(["add", "deploy m5", "--state", "approve", "--reason", "restart", "--company", "pgw"]); // pgw-1
    expect(ok.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    for (let n = 1; n <= 9; n++) expect(t.body).toContain(`## ${n}.`); // all 9 sections prefilled
    expect(ok.output).toContain("prefilled 9-section approval template");
  });

  test("add --state approve with a PARTIAL --body warns which sections are missing (kobo-222)", async () => {
    const ok = await run(["add", "deploy", "--state", "approve", "--reason", "r", "--body", "## 1. Deploy\n## 4. เงิน", "--company", "pgw"]); // pgw-1
    expect(ok.ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.body).toBe("## 1. Deploy\n## 4. เงิน"); // supplied body kept as-is
    expect(ok.output).toContain("missing 7/9 section(s)"); // 2,3,5,6,7,8,9 flagged
  });

  test("reject on a done card is refused — terminal, no resurrection (kobo-101)", async () => {
    await run(["add", "shipped", "--company", "pgw"]); // pgw-1
    await run(["done", "pgw-1", "--company", "pgw"]);
    const r = await run(["reject", "pgw-1", "--reason", "too late", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already done");
    expect(readTask("pgw", "pgw-1")!.state).toBe("done"); // stays done
  });

  test("missing id / unknown subcommand → clean error, not a throw", async () => {
    expect((await run(["claim", "--company", "pgw"])).error).toContain("usage");
    const bogus = await run(["bogus"]);
    expect(bogus.ok).toBe(false);
    // kobo-237/238 fold: the usage string must NOT advertise the removed `resolve` verb
    // (a guard that only checks for "usage" false-greens on a stale verb list).
    expect(bogus.error).toContain("usage");
    expect(bogus.error).not.toContain("resolve");
    expect((await run(["done", "pgw-999", "--company", "pgw"])).error).toContain("not found");
    expect((await run(["reject", "pgw-999", "--reason", "x", "--company", "pgw"])).error).toContain("not found");
    expect(listTasks("pgw")).toEqual([]);
  });

  // ── kobo-126: ask / mentions / flag-shaped-value guard ─────────────────────

  test("ask creates a parent-linked subcard assigned to the answerer (no ping when to===me)", async () => {
    await run(["add", "parent epic", "--company", "pgw", "--kind", "epic", "--from", "patchwork"]);
    // --from patchwork --to patchwork → assignee === actor → no ping fires (hermetic)
    const r = await run(["ask", "pgw-1", "ship X or Y?", "--to", "patchwork", "--company", "pgw", "--from", "patchwork"]);
    expect(r.ok).toBe(true);
    const sub = readTask("pgw", "pgw-2")!;
    expect(sub.title).toBe("ship X or Y?");
    expect(sub.epic).toBe("pgw-1"); // hung under the parent
    expect(sub.assignee).toBe("patchwork");
    expect((await run(["ask", "pgw-999", "q?", "--to", "patchwork", "--company", "pgw", "--from", "patchwork"])).error).toContain("parent card not found");
  });

  test("mentions reads @mentions from COMMENTS (kobo-140 repoint; kobo-237: no resolve drop)", async () => {
    await run(["add", "card A", "--company", "pgw"]);
    // kobo-263: a @tony comment now needs --tldr + --ask (structured gate)
    await run(["comment", "pgw-1", "@tony", "--tldr", "rename?", "--ask", "rename the card?", "--company", "pgw"]);
    const q = await run(["mentions", "--for", "tony", "--company", "pgw"]);
    expect(q.output).toContain("pgw-1");
    expect(q.output).toContain("@tony");
    expect(q.output).toContain("c1"); // the comment id rides the queue line
    // kobo-237: no resolve verb — the mention stays until trimmed by mark-as-read (kobo-238)
    const bad = await run(["resolve", "pgw-1", "c1", "--from", "tony", "--company", "pgw"]);
    expect(bad.error).toContain("usage"); // resolve subcommand is gone → generic usage
  });

  test("kobo-263: a @tony/@human comment REJECTS without --tldr+--ask; agent↔agent is free", async () => {
    await run(["add", "card A", "--company", "pgw", "--assignee", "patchwork"]);
    // @tony, no structured fields → rejected (must distill first)
    const bare = await run(["comment", "pgw-1", "@tony", "approve", "the", "deploy?", "--from", "eq3", "--company", "pgw"]);
    expect(bare.ok).toBe(false);
    expect(bare.error).toContain("--tldr");
    expect(readTask("pgw", "pgw-1")!.comments ?? []).toHaveLength(0); // nothing written on a reject
    // @tony WITH tldr+ask → accepted + the structured echo renders
    const full = await run(["comment", "pgw-1", "@tony", "--tldr", "deploy is green", "--ask", "approve prod?", "--from", "eq3", "--company", "pgw"]);
    expect(full.ok).toBe(true);
    expect(full.output).toContain("TL;DR");
    expect(readTask("pgw", "pgw-1")!.comments!.at(-1)).toMatchObject({ tldr: "deploy is green", ask: "approve prod?" });
    // agent↔agent → free, no fields required
    const agent = await run(["comment", "pgw-1", "@patchwork", "rebased,", "ready", "--from", "eq3", "--company", "pgw"]);
    expect(agent.ok).toBe(true);
  });

  test("a @mention inside a NOTE does NOT enter the mentions queue (rule 10 — notes are log, not asks)", async () => {
    await run(["add", "card A", "--company", "pgw"]);
    await run(["note", "pgw-1", "logged:", "pinged", "@tony", "elsewhere", "--company", "pgw"]);
    expect((await run(["mentions", "--for", "tony", "--company", "pgw"])).output).toContain("no pending mentions");
  });

  test("comment threads (--reply-to), comments lists them (kobo-140; kobo-237: no resolve)", async () => {
    await run(["add", "card A", "--company", "pgw", "--assignee", "patchwork"]);
    const c1 = await run(["comment", "pgw-1", "can you look?", "--from", "eq3", "--company", "pgw"]);
    expect(c1.ok).toBe(true);
    expect(c1.output).toContain("c1");
    const c2 = await run(["comment", "pgw-1", "on it", "--reply-to", "c1", "--from", "patchwork", "--company", "pgw"]);
    expect(c2.output).toContain("c2 ↳ c1");
    const list = await run(["comments", "pgw-1", "--company", "pgw"]);
    expect(list.output).toContain("can you look?");
    expect(list.output).toContain("on it");
    expect(list.output).not.toContain("resolved"); // kobo-237: no resolved marker
    // usage / not-found errors are clean
    expect((await run(["comment", "pgw-1", "--company", "pgw"])).error).toContain("usage");
    expect((await run(["comment", "pgw-999", "hi", "--company", "pgw"])).error).toContain("task not found");
    expect((await run(["comment", "pgw-1", "x", "--reply-to", "c99", "--company", "pgw"])).error).toContain("reply target not found");
    // kobo-237: the resolve subcommand is gone → generic usage error
    expect((await run(["resolve", "pgw-1", "c1", "--company", "pgw"])).error).toContain("usage");
  });

  test("migrate-comments copies @-notes → comments (note kept), dry-run + idempotent (kobo-142)", async () => {
    await run(["add", "card A", "--company", "pgw", "--assignee", "patchwork"]);
    await run(["note", "pgw-1", "@tony", "rename?", "--company", "pgw"]);
    // dry-run reports the count but writes nothing
    const dry = await run(["migrate-comments", "--dry-run", "--company", "pgw"]);
    expect(dry.output).toContain("DRY-RUN");
    expect(dry.output).toContain("1 migrated");
    expect((await run(["comments", "pgw-1", "--company", "pgw"])).output).toContain("no comments");
    // real run: the @-note becomes a comment; the note stays; the queue surfaces it
    const run1 = await run(["migrate-comments", "--company", "pgw"]);
    expect(run1.output).toContain("1 migrated");
    expect((await run(["comments", "pgw-1", "--company", "pgw"])).output).toContain("@tony rename?");
    expect(readTask("pgw", "pgw-1")!.notes!.length).toBe(1); // note KEPT
    expect((await run(["mentions", "--for", "tony", "--company", "pgw"])).output).toContain("pgw-1");
    // idempotent: re-run migrates nothing more
    const rerun = (await run(["migrate-comments", "--company", "pgw"])).output;
    expect(rerun).toContain("0 migrated");
    expect(rerun).toContain("1 already present");
    expect(readTask("pgw", "pgw-1")!.comments!.length).toBe(1);
  });

  test("add rejects a flag-shaped ref value — no corrupt epic:\"--add\" (kobo-126, pgw-35 root cause)", async () => {
    // the `=` form binds "--add" as the epic value in arg(permissive); reject it
    const r = await run(["add", "corrupt", "--company", "pgw", "--epic=--add"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--epic");
    expect(listTasks("pgw")).toEqual([]); // nothing persisted
  });

  test("epic verb rejects a flag-shaped epicId (positional stray flag)", async () => {
    await run(["add", "real card", "--company", "pgw"]);
    const r = await run(["epic", "pgw-1", "--add", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(readTask("pgw", "pgw-1")!.epic).toBeUndefined(); // never set to garbage
  });

  // kobo-246 — the `ls` board (emitted via the runner) must NOT show the derived 🚫
  // dep-block label on a done card whose parent is still pending, nor pull it off-flow;
  // an active card with the same pending parent still must (no regression).
  test("done card with a still-backlog parent → no 🚫 label, not pulled off-flow (kobo-246)", async () => {
    await run(["add", "parent", "--company", "pgw"]); // pgw-1
    await run(["move", "pgw-1", "backlog", "--company", "pgw"]); // parent parked → exempt from needsOwner
    await run(["add", "child", "--company", "pgw", "--parent", "pgw-1"]); // pgw-2 depends on the pending parent
    const active = (await run(["ls", "--company", "pgw"])).output;
    expect(active).toContain("🚫 รอ: pgw-1"); // control: the not-yet-done child IS dep-blocked

    await run(["done", "pgw-2", "--company", "pgw"]);
    expect(readTask("pgw", "pgw-2")!.state).toBe("done");
    const finished = (await run(["ls", "--company", "pgw"])).output;
    expect(finished).not.toContain("🚫 รอ: pgw-1"); // done child no longer shows the label
    expect(finished).not.toContain("BLOCKED"); // and isn't pulled into the Blocked lane
  });

  // kobo-255 — the wait-label lives in the Blocked lane only. slice-A makes a dep-pending
  // card really state="blocked", so a card in a flow lane (in-progress) never carries a
  // derived dep-block overlay. A child of an ALREADY-DONE parent isn't dep-pending → it
  // sits in its flow lane with no 🚫, proving the overlay isn't derived onto other states.
  test("in-progress child of a done parent → flow lane, no 🚫 overlay (kobo-255)", async () => {
    await run(["add", "parent", "--company", "acme"]); // acme-1
    await run(["done", "acme-1", "--company", "acme"]); // parent finished before the child exists
    await run(["add", "child", "--company", "acme", "--parent", "acme-1"]); // acme-2, deps all clear
    await run(["start", "acme-2", "--company", "acme"]); // → in-progress
    expect(readTask("acme", "acme-2")!.state).toBe("in-progress");
    const board = (await run(["ls", "--company", "acme"])).output;
    expect(board).not.toContain("🚫 รอ"); // no dep-block overlay on the in-progress card
  });
});
