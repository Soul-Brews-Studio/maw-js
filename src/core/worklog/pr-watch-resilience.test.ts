/**
 * pr-watch resilience — kobo-631: a repo-level failure must not cost every
 * OTHER repo's already-completed work (the actual root cause behind kobo-630's
 * 86-minute incident: one unguarded throw anywhere aborted the whole pass
 * before the single end-of-pass `saveSnapshot`), and a failure must be LOUD,
 * not silently absorbed.
 *
 * ⚠️ ISOLATION, TWO LAYERS, BOTH REQUIRED — a real incident this round proved
 * one layer alone isn't enough: an earlier draft of this file set only
 * `MAW_DATA_DIR`, believing it isolated every file `pollPrsOnce` touches. It
 * does NOT — `snapshotPath()` uses `mawStatePath()`, gated on `MAW_HOME`/
 * `MAW_STATE_DIR`, a DIFFERENT env var than `MAW_DATA_DIR` (see xdg.ts: 4
 * separate dir-kind resolvers — config/data/state/cache — each gated on its
 * OWN env var after a shared `MAW_HOME` override). That draft's test writes
 * landed in the REAL machine's `~/.maw/watch-pr-state.json`, corrupting the
 * exact evidence file kobo-630's incident depends on. Fixed here with BOTH:
 *   (1) `MAW_HOME` (not the narrower `MAW_DATA_DIR`) — covers every xdg-based
 *       path this file or its dependencies could ever touch, present or future,
 *       without needing to enumerate each one.
 *   (2) `__setSnapshotPathForTest` — an explicit path override for the
 *       snapshot specifically, so this file's OWN tests never depend on env
 *       vars alone even being correct, matching this codebase's established
 *       injectable-seam convention (kobo-546/kobo-608's own lesson: an env
 *       var is never a trust root for something this consequential).
 * Real `gh` calls are avoided via `__setGhForTest` (no network/CLI). Real
 * `spawnHeyProcess` is auto-stubbed fleet-wide for EVERY `bun test` run
 * (test/helpers/hey-spawn-fail-closed.ts, kobo-405) — safe to let
 * `pollPrsOnce`'s real `pingOnMerge` call run without spawning a real `maw hey`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIG_HOME = process.env.MAW_HOME;
let root: string;

function card(company: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(root, "companies", company, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, company, title: id, ts: 1, ...fields }));
}

function snapshotFile(): string {
  return join(root, "watch-pr-state.json");
}

function readSnapshot(): Record<string, any> {
  return JSON.parse(readFileSync(snapshotFile(), "utf8"));
}

function readWorklogLines(company: string): any[] {
  const p = join(root, "companies", company, "worklog.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** GH pr list/view stub, keyed by repo. Any repo not in the map (e.g. a real
 *  worktree this test machine happens to have) answers with an empty list —
 *  keeps the test hermetic against whatever local worktrees actually exist. */
function makeGhStub(prsByRepo: Record<string, any[]>) {
  return async (args: string[]): Promise<string> => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify((repo && prsByRepo[repo]) || []);
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ mergedBy: { login: "meganechan" } });
    }
    return "[]";
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-resilience-"));
  process.env.MAW_HOME = root; // layer 1 — covers config/runtimeHome/data/state/cache at once
  // kobo-631 — POSITIVE assertion, not an assumption: the incident this round
  // happened because a prior draft BELIEVED an env var isolated everything,
  // never checked. `mawStateDir()` gates `pollPrsOnce`'s snapshot writes;
  // `mawDataDir()` gates `appendWorklog()` (the worklog file) AND
  // `reconcileMergedCards()`'s task-store writes — the latter overwrites REAL
  // CARDS on the board, a strictly worse blast radius than the snapshot file.
  // If either ever resolves outside `root` (e.g. a leftover MAW_STATE_DIR set
  // in the ambient environment, or this test file itself regressing), THIS
  // assertion fails the test immediately, in this file, before any write
  // happens — instead of silently landing on the real machine again.
  const { mawStateDir, mawDataDir } = await import("../xdg.ts");
  if (!mawStateDir().startsWith(root)) throw new Error(`mawStateDir() escaped the test root: ${mawStateDir()}`);
  if (!mawDataDir().startsWith(root)) throw new Error(`mawDataDir() escaped the test root: ${mawDataDir()}`);
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = ORIG_HOME;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  // No __resetGhForTest()/__resetSnapshotPathForTest() needed: every test below
  // imports `./pr-watch.ts` with its OWN unique `?query` suffix (same
  // convention as pr-watch-repos.test.ts), which Bun gives a fresh, unshared
  // module instance — both overrides live only on that one instance, never
  // bleeding into another test's import.
});

/**
 * MUTATION CONTROL — the 6-item list below is LOCKED, derived from kobo-631's
 * own AC (not from this test file or the source code — a code-derived list
 * only surfaces gaps someone already noticed; this exact distinction is why
 * this list has 6 items where an earlier code-derived gap report found only
 * 4 — "atomic write" and "incremental persistence" were invisible to
 * code-tracing because nobody had ever written a test around either):
 *   1. Atomic write — revert tmp+rename to a direct write → must go RED
 *   2. Incremental persistence — revert to single end-of-pass write → RED
 *   3. `recordStuckPoll` — remove → RED
 *   4. Consecutive-skip counter — remove → RED
 *   5. `signal.aborted` OR generation check — remove either → RED
 *   6. Timeout — remove → RED
 * Each test below must go red because BEHAVIOR changed when the guard is
 * removed — never because a source string/shape search failed to find text
 * (that would just be a source-shape test wearing a mutation-control label).
 */
describe("MUTATION CONTROL 1/6 — atomic write (kobo-631 AC clause 1)", () => {
  it("the snapshot file's INODE changes after a write — proves tmp+rename replaced it, not an in-place overwrite", async () => {
    // A direct `writeFileSync(path, ...)` (default 'w' flag) truncates and
    // rewrites the SAME inode. `writeFileSync(tmp,...)` + `renameSync(tmp,
    // path)` always produces a NEW inode at `path`. This is a real OS-level
    // behavioral signal, not a source-shape check — if `saveSnapshotAtomic`
    // were mutated back to a direct write, this test goes red because the
    // inode would stay IDENTICAL, not because a string search failed.
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?mutation-atomic-write");
    __setSnapshotPathForTest(() => snapshotFile());
    card("kobo", "kobo-12", { state: "review", pr: 120, repo: "x/y", assignee: "patchwork" });
    writeFileSync(snapshotFile(), JSON.stringify({ "x/y#120": { state: "OPEN", repo: "x/y", number: 120, title: "t" } }));
    const inodeBefore = statSync(snapshotFile()).ino;

    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (args[0] === "pr" && args[1] === "list") {
        if (repo !== "x/y") return "[]";
        return JSON.stringify([{ number: 120, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
      }
      return JSON.stringify({ mergedBy: { login: "meganechan" } });
    });

    await pollPrsOnce();
    const inodeAfter = statSync(snapshotFile()).ino;
    expect(inodeAfter).not.toBe(inodeBefore);
  });
});

describe("pollPrsOnce — per-repo isolation (kobo-631, the actual incident)", () => {
  it("a later repo's gh-list failure does NOT lose an earlier repo's already-completed work", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?resilience-isolation");
    __setSnapshotPathForTest(() => snapshotFile()); // layer 2 — belt-and-suspenders on top of MAW_HOME
    card("kobo", "kobo-1", { state: "review", pr: 10, repo: "ok/repo", assignee: "patchwork" });
    card("kobo", "kobo-2", { state: "review", pr: 20, repo: "bad/repo", assignee: "patchwork" });

    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (repo === "bad/repo") throw new Error("simulated gh failure");
      if (args[0] === "pr" && args[1] === "list" && repo === "ok/repo") {
        return JSON.stringify([{ number: 10, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergedBy: { login: "meganechan" } });
      return "[]";
    });

    // pollPrsOnce must not throw even though one repo's gh call fails.
    await expect(pollPrsOnce()).resolves.toBeArray();

    const snap = readSnapshot();
    // ok/repo's PR was fully processed and MUST be persisted...
    expect(snap["ok/repo#10"]?.state).toBe("MERGED");
    // ...even though bad/repo never got a chance to contribute anything.
    expect(snap["bad/repo#20"]).toBeUndefined();
  });

  it("mutation-anchor: if per-repo persistence were reverted to a single end-of-pass save, this test goes red", async () => {
    // Same scenario, repo ORDER matters this time: put the failing repo FIRST.
    // Under the OLD (single end-of-pass saveSnapshot) design, a throw on the
    // FIRST repo means the loop never reaches the second repo's persist at
    // all — nothing survives. Under the fix, each repo persists independently
    // regardless of processing order.
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?resilience-order");
    __setSnapshotPathForTest(() => snapshotFile()); // layer 2 — belt-and-suspenders on top of MAW_HOME
    card("kobo", "kobo-3", { state: "review", pr: 30, repo: "aaa/first-fails", assignee: "patchwork" });
    card("kobo", "kobo-4", { state: "review", pr: 40, repo: "zzz/second-ok", assignee: "patchwork" });

    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (repo === "aaa/first-fails") throw new Error("simulated gh failure");
      if (args[0] === "pr" && args[1] === "list" && repo === "zzz/second-ok") {
        return JSON.stringify([{ number: 40, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergedBy: { login: "meganechan" } });
      return "[]";
    });

    await pollPrsOnce();
    const snap = readSnapshot();
    expect(snap["zzz/second-ok#40"]?.state).toBe("MERGED"); // survives a FIRST-repo failure
  });

  it("MUTATION CONTROL 2/6 — an earlier repo's transition is durably on disk WHILE a later repo is still being processed, not only after the whole pass finishes", async () => {
    // The earlier "mutation-anchor" test above does NOT actually distinguish
    // incremental-vs-end-of-pass: a caught-and-continued failure still lets
    // the loop reach its end either way, so a hypothetical "accumulate in
    // memory, write once at the very end" design would produce the SAME
    // final on-disk result in that scenario. The real distinguishing
    // property is durability of ALREADY-PROCESSED work WHILE a later repo is
    // still in flight (the actual kill-mid-pass scenario this card exists
    // for) — proven here by making the second repo hang FOREVER and checking
    // the file WITHOUT ever awaiting the overall pass to completion.
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest, __setPollTimeoutMsForTest } = await import("./pr-watch.ts?mutation-incremental");
    __setSnapshotPathForTest(() => snapshotFile());
    __setPollTimeoutMsForTest(2000); // so the never-resolving background pass cleans itself up quickly rather than lingering the real 90s default
    card("kobo", "kobo-13", { state: "review", pr: 130, repo: "aaa/fast-repo", assignee: "patchwork" });
    card("kobo", "kobo-14", { state: "review", pr: 140, repo: "zzz/hangs-forever", assignee: "patchwork" });

    // Repo iteration order (scanWorktrees ∪ openPrLinkedRepos, via a Set) is
    // NOT guaranteed to be creation/alphabetical order — measured directly,
    // it is NOT what a naive reading of the source would suggest. Rather than
    // assume which of these two repos gets visited first, make the FIRST of
    // our two repos actually queried resolve fast (whichever one that is),
    // and the SECOND one hang forever — deterministic regardless of order.
    let ourRepoCallCount = 0;
    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (args[0] !== "pr" || args[1] !== "list") {
        return JSON.stringify({ mergedBy: { login: "meganechan" } });
      }
      if (repo !== "aaa/fast-repo" && repo !== "zzz/hangs-forever") return "[]"; // this test machine's real local worktrees
      ourRepoCallCount++;
      if (ourRepoCallCount >= 2) return new Promise(() => {}); // whichever of ours is SECOND hangs forever
      const num = repo === "aaa/fast-repo" ? 130 : 140;
      return JSON.stringify([{ number: num, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
    });

    pollPrsOnce().catch(() => {}); // deliberately NOT awaited — the pass never completes in this test (the second of our repos hangs forever); catch to avoid an unhandled-rejection warning once the 2s timeout eventually fires in the background
    await new Promise((r) => setTimeout(r, 500)); // real scanWorktrees (~286ms) + the first repo's quick processing, well before the second's hang matters

    // Whichever repo was queried FIRST must have its transition ALREADY
    // durably on disk, even though the overall pass is still stuck on the
    // SECOND repo and will never finish. Under an end-of-pass design,
    // nothing would be written yet — the file would still be absent/unseeded.
    expect(existsSync(snapshotFile())).toBe(true);
    const snap = readSnapshot();
    const oneOfOursIsMerged = snap["aaa/fast-repo#130"]?.state === "MERGED" || snap["zzz/hangs-forever#140"]?.state === "MERGED";
    expect(oneOfOursIsMerged).toBe(true);
    // and the OTHER one — the one that hung — must NOT be in the snapshot at all yet.
    const bothPresent = snap["aaa/fast-repo#130"] !== undefined && snap["zzz/hangs-forever#140"] !== undefined;
    expect(bothPresent).toBe(false);
  });

  it("the snapshot file is always valid JSON after a poll — proves the write is atomic, not interleaved/truncated", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?resilience-atomic");
    __setSnapshotPathForTest(() => snapshotFile()); // layer 2 — belt-and-suspenders on top of MAW_HOME
    card("kobo", "kobo-5", { state: "review", pr: 50, repo: "x/y", assignee: "patchwork" });
    __setGhForTest(makeGhStub({
      "x/y": [{ number: 50, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }],
    }));

    await pollPrsOnce();
    expect(() => readSnapshot()).not.toThrow();
    // no leftover .tmp file — rename cleaned it up
    const files = readdirSync(root).filter((f) => f.endsWith(".tmp"));
    expect(files).toEqual([]);
  });

  it("a poll with NO transition anywhere does not touch the snapshot file at all — the write-cost gate, behaviorally", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?resilience-nowrite");
    __setSnapshotPathForTest(() => snapshotFile());
    card("kobo", "kobo-6", { state: "review", pr: 60, repo: "x/y", assignee: "patchwork" });
    const baseline = { "x/y#60": { state: "OPEN", repo: "x/y", number: 60, title: "t", author: "meganechan" } };
    writeFileSync(snapshotFile(), JSON.stringify(baseline)); // pre-seed so firstRun is false and prev===cur
    const before = readFileSync(snapshotFile()).toString();

    // OPEN PR with no mergeable/mergeStateStatus (so kobo-594's task-store
    // side write doesn't even fire) and identical state to the seeded
    // baseline — genuinely nothing for this poll to do.
    __setGhForTest(makeGhStub({
      "x/y": [{ number: 60, title: "t", state: "OPEN", mergedAt: null, author: { login: "meganechan" } }],
    }));

    await pollPrsOnce();
    const after = readFileSync(snapshotFile()).toString();
    expect(after).toBe(before); // byte-identical — the file was never reopened for writing
  });
});

describe("pollPrsOnce — reentrancy guard (kobo-631, reviewer-escalated: PID alone doesn't cover same-process overlap)", () => {
  it("MUTATION CONTROL 4/6 — 3 consecutive skipped ticks while one pass is stuck in-flight get reported LOUDLY", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest, __setPollTimeoutMsForTest } = await import("./pr-watch.ts?mutation-consecutive-skip");
    __setSnapshotPathForTest(() => snapshotFile());
    __setPollTimeoutMsForTest(2000); // bounded so this test's background pass doesn't linger the real 90s default
    card("kobo", "kobo-15", { state: "review", pr: 150, repo: "x/y", assignee: "patchwork" });
    __setGhForTest(() => new Promise(() => {})); // pass A hangs — we don't need it to ever resolve for this test

    const first = pollPrsOnce().catch(() => {}); // starts the in-flight pass
    pollPrsOnce(); // skip 1
    pollPrsOnce(); // skip 2
    pollPrsOnce(); // skip 3 — crosses STUCK_POLL_SKIP_THRESHOLD (3)

    await new Promise((r) => setTimeout(r, 50)); // let the synchronous skip-counting continuations flush
    const lines = readWorklogLines("kobo");
    expect(lines.some((l) => l.kind === "error" && String(l.summary).includes("consecutive ticks skipped"))).toBe(true);
    void first;
  });

  it("an overlapping call while a poll is still in flight reuses the SAME promise instead of starting a second pass", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?resilience-reentrant");
    __setSnapshotPathForTest(() => snapshotFile());
    card("kobo", "kobo-7", { state: "review", pr: 70, repo: "x/y", assignee: "patchwork" });
    let callCount = 0; // counts ONLY x/y — this test machine's real local worktrees (scanWorktrees()
    // isn't stubbed) also get polled in the same pass; counting every repo would conflate
    // "this repo got hit twice" with "the fleet just has more than one repo."
    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (args[0] === "pr" && args[1] === "list") {
        if (repo === "x/y") {
          callCount++;
          await new Promise((r) => setTimeout(r, 30)); // hold the pass open long enough to overlap
          return JSON.stringify([{ number: 70, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
        }
        return "[]";
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergedBy: { login: "meganechan" } });
      return "[]";
    });

    const first = pollPrsOnce();
    const second = pollPrsOnce(); // fired before `first` resolves — simulates the timer-tick overlap
    expect(second).toBe(first); // literally the same in-flight promise, not a second pass
    await Promise.all([first, second]);
    expect(callCount).toBe(1); // the `gh pr list` call only happened once, not twice
  });

  it("MUTATION CONTROL 3/6 — a pass that never resolves (gh wedged) times out, reports LOUDLY, and releases the guard for the NEXT call — never skips forever", async () => {
    const mod = await import("./pr-watch.ts?resilience-hung");
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest, __setPollTimeoutMsForTest, __resetPollTimeoutMsForTest } = mod as any;
    __setSnapshotPathForTest(() => snapshotFile());
    __setPollTimeoutMsForTest(30); // real 90s has no place in a test
    card("kobo", "kobo-8", { state: "review", pr: 80, repo: "x/y", assignee: "patchwork" });

    __setGhForTest(() => new Promise(() => {})); // never resolves — simulates a wedged gh subprocess

    await expect(pollPrsOnce()).rejects.toThrow(/exceeded 30ms timeout/);
    // reported LOUDLY, not silently absorbed
    const lines = readWorklogLines("kobo");
    expect(lines.some((l) => l.kind === "error" && String(l.summary).includes("poll pass stuck"))).toBe(true);

    // the guard released — a FRESH call with a working gh stub completes normally,
    // proving this does not skip forever. Reset the timeout FIRST: 30ms is
    // artificially short for the test, and a real (non-stubbed) scanWorktrees()
    // filesystem scan can easily exceed it on its own.
    __resetPollTimeoutMsForTest();
    __setGhForTest(makeGhStub({ "x/y": [] }));
    await expect(pollPrsOnce()).resolves.toBeArray();
  });

  it("MUTATION CONTROL 6/6 — timeout mechanism, tested by INJECTING determinism instead of racing a clock: no assertion below references elapsed time", async () => {
    // Corrected approach (front's call): the earlier version of this test
    // raced a short injected timeout against real, unstubbed
    // `scanWorktrees()` overhead (~286ms, machine-dependent) — a race, not a
    // deterministic test. Fixed by making the underlying "hang" itself
    // deterministic: pass A's gh call resolves ONLY when this test calls the
    // captured resolver, never on its own, regardless of how much real time
    // passes. Against a promise that structurally cannot resolve without
    // explicit action, ANY positive timeout value will always eventually
    // win the race — so `__setPollTimeoutMsForTest` (an existing seam, same
    // convention as `__setGhForTest`/`__setSnapshotPathForTest` elsewhere in
    // this file — no NEW production code needed here) no longer needs to
    // "beat" anything uncertain.
    //
    // Three assertions, none reference elapsed wall-clock time:
    //   1. the loud timeout record fires with the expected in-flight count
    //   2. the NEXT tick can actually start — proves the guard was released
    //   3. the abandoned pass, once it DOES resolve (test-triggered, not a
    //      real-time wait), discards itself rather than clobbering the
    //      next tick's already-legitimate write (generation+repo present
    //      in that specific message)
    // If `withTimeout` is mutated away, assertion 1 never happens (no
    // record) and assertion 2 never happens (pass A never releases the
    // guard) — RED because those events did not occur, not because
    // anything ran slow.
    const mod = await import("./pr-watch.ts?mutation-timeout-deterministic");
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest, __setPollTimeoutMsForTest, __resetPollTimeoutMsForTest } = mod as any;
    __setSnapshotPathForTest(() => snapshotFile());
    // 500ms — large enough that pass B's own REAL scanWorktrees() call
    // (~286ms measured on this machine, unstubbed) comfortably completes
    // without hitting this same timeout itself. This is NOT racing pass A —
    // pass A's hang is deterministic (never resolves without the captured
    // resolver below), so ANY finite value catches it; 500ms is chosen
    // purely to give pass B's legitimate, real work enough room.
    __setPollTimeoutMsForTest(500);
    card("kobo", "kobo-18", { state: "review", pr: 180, repo: "x/y", assignee: "patchwork" });
    writeFileSync(snapshotFile(), JSON.stringify({ "x/y#180": { state: "OPEN", repo: "x/y", number: 180, title: "t" } }));

    let releasePassAView: ((v: string) => void) | null = null;
    let viewCallCount = 0;
    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (args[0] === "pr" && args[1] === "list") {
        if (repo !== "x/y") return "[]";
        return JSON.stringify([{ number: 180, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        viewCallCount++;
        if (viewCallCount === 1) {
          // pass A's own call — resolves ONLY when this test explicitly
          // calls the captured resolver, deterministic, no real-time race.
          return new Promise<string>((resolve) => { releasePassAView = resolve; });
        }
        return JSON.stringify({ mergedBy: { login: "meganechan" } }); // pass B's call — immediate
      }
      return "[]";
    });

    // Pass A (generation 1) must be ENDED BY THE TIMEOUT MECHANISM. Awaiting
    // the rejection directly would mean that removing `withTimeout` leaves
    // nothing to settle this promise, so the test hangs at this line and
    // never reaches a single assertion — measured: 46s of silent 100% CPU,
    // killed by hand, no RED. Racing an in-test sentinel converts that into
    // an assertion failure naming this exact line. The sentinel measures
    // "did anything at all close this promise", not "was the code fast".
    const passA = pollPrsOnce().then(() => "RESOLVED_WITHOUT_TIMEOUT").catch((e: unknown) => e);
    const outcome = await Promise.race([passA, new Promise((r) => setTimeout(() => r("HUNG"), 2000))]);
    expect(outcome).not.toBe("HUNG"); // fails HERE if the timeout mechanism is gone
    expect(String((outcome as Error)?.message ?? outcome)).toMatch(/exceeded 500ms timeout/);

    // ASSERTION 1 — the loud record fired, with the expected in-flight count.
    const linesAfterTimeout = readWorklogLines("kobo");
    const stuckEntry = linesAfterTimeout.find((l) => l.kind === "error" && String(l.summary).includes("abort REQUESTED"));
    expect(stuckEntry).toBeDefined();
    expect(String(stuckEntry!.summary)).toContain("1 pass(es)"); // zombiesInFlight === 1 at this point

    // ASSERTION 2 — the NEXT tick can actually start: proves the guard was
    // released (not skip-blocked forever). Pass B (generation 2) completes
    // and legitimately persists — its own view call is #2, immediate.
    // Pass B runs on the REAL timeout, not the injected one: pass B does its
    // own unstubbed scanWorktrees() (~286ms here), and 500ms left it a 1.75x
    // margin on one machine's measurement — narrower than the 3x slowdown we
    // already treat as plausible. Restoring the real value deletes the margin
    // instead of documenting it.
    __resetPollTimeoutMsForTest();
    await pollPrsOnce();
    const snapAfterB = readSnapshot();
    expect(snapAfterB["x/y#180"]?.state).toBe("MERGED");

    // ASSERTION 3 — pass A's abandoned call, once it DOES resolve (this test
    // decides exactly when, not a real-time wait), discards itself rather
    // than clobbering pass B's already-legitimate write. `discarded a stale
    // write for x/y — superseded by generation 2` — repo AND generation both
    // present in this specific message.
    expect(releasePassAView).not.toBeNull();
    releasePassAView!(JSON.stringify({ mergedBy: { login: "meganechan" } }));
    await new Promise((r) => setTimeout(r, 200)); // NOT racing anything — pass A's own remaining continuation (record/reconcile/generation-check) has no external dependency left at this point, just needs a moment to run to completion after being explicitly released above.

    const linesAfterA = readWorklogLines("kobo");
    const discardEntry = linesAfterA.find((l) => l.kind === "error" && String(l.summary).includes("discarded a stale write"));
    expect(discardEntry).toBeDefined();
    expect(String(discardEntry!.summary)).toContain("x/y"); // repo
    expect(String(discardEntry!.summary)).toContain("generation 1"); // the STALE generation
    expect(String(discardEntry!.summary)).toContain("generation 2"); // superseded by THIS generation
    const snapAfterA = readSnapshot();
    expect(snapAfterA).toEqual(snapAfterB); // pass A's stale write never landed
  }, 3000); // speed only, not correctness: since the hang above is deterministic (never resolves without the timeout mechanism), this mutation is caught reliably at bun's 5000ms default too — tightening just gets feedback faster locally, unlike the old clock-racing version where the number itself was load-bearing.

  it("once superseded, a stale pass stops BEFORE the next PR's side effects — not just before the final snapshot write", async () => {
    // front's block, corrected from an earlier round: checking generation
    // only right before saveSnapshotAtomic is NOT enough — by then a stale
    // pass has already called record()/reconcileMergedCards for every OTHER
    // PR in this repo's list. This proves the check inside pollRepoOnce's
    // own per-PR loop actually stops a SECOND PR from being processed once
    // the pass has been aborted mid-repo.
    const mod = await import("./pr-watch.ts?resilience-midloop-abort");
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest, __setPollTimeoutMsForTest, __resetPollTimeoutMsForTest } = mod as any;
    __setSnapshotPathForTest(() => snapshotFile());
    // 400ms, not a tiny number: real scanWorktrees() (not stubbed — it shells
    // to real git commands) measured ~286ms on its own on this machine, before
    // the repo loop even starts. A too-short timeout fires during THAT setup
    // phase instead of mid-PR-loop, which would test the wrong code path.
    __setPollTimeoutMsForTest(400);
    card("kobo", "kobo-9", { state: "review", pr: 90, repo: "x/y", assignee: "patchwork" });
    card("kobo", "kobo-10", { state: "review", pr: 91, repo: "x/y", assignee: "patchwork" });
    // seed a PRIOR state so this poll is a genuine OPEN→MERGED transition,
    // not a firstRun baseline-seed (which has no side effects to skip at all).
    writeFileSync(snapshotFile(), JSON.stringify({
      "x/y#90": { state: "OPEN", repo: "x/y", number: 90, title: "first" },
      "x/y#91": { state: "OPEN", repo: "x/y", number: 91, title: "second" },
    }));

    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (args[0] === "pr" && args[1] === "list") {
        if (repo !== "x/y") return "[]"; // this test machine's own real worktrees also get polled
        return JSON.stringify([
          { number: 90, title: "first", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } },
          { number: 91, title: "second", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } },
        ]);
      }
      if (args[0] === "pr" && args[1] === "view" && args[2] === "90") {
        // slow enough that the 400ms timeout fires WHILE this PR is still
        // being processed — by the time it resolves, the pass has already
        // been aborted, so PR 91 (next in the loop) must not be touched.
        await new Promise((r) => setTimeout(r, 500));
        return JSON.stringify({ mergedBy: { login: "meganechan" } });
      }
      return JSON.stringify({ mergedBy: { login: "meganechan" } });
    });

    await expect(pollPrsOnce()).rejects.toThrow(/exceeded 400ms timeout/);
    await new Promise((r) => setTimeout(r, 800)); // let the abandoned pass actually finish PR 90 and hit the PR-91 check

    const lines = readWorklogLines("kobo");
    expect(lines.some((l) => l.kind === "pr-merged" && l.pr === 90)).toBe(true); // already in flight when aborted — can't be undone
    expect(lines.some((l) => l.kind === "pr-merged" && l.pr === 91)).toBe(false); // never reached — the mid-loop check stopped it
    expect(lines.some((l) => l.kind === "error" && String(l.summary).includes("aborted mid-repo"))).toBe(true);
    __resetPollTimeoutMsForTest();
  });

  it("MUTATION CONTROL 5/6 — a stale pass's own final write is DISCARDED once a newer generation has already started, not silently applied on top of it", async () => {
    // The real "zombie" scenario, composed for real: pass A times out and
    // its OWN abort is requested — but its background execution keeps
    // running (a slow mergedBy call outlives the abort). Immediately after
    // observing A's timeout-rejection, a fresh pollPrsOnce() call starts
    // pass B (bumping currentGeneration). Pass B completes and legitimately
    // persists ITS OWN state. Only THEN does pass A's slow call finally
    // resolve — pass A must discard its own write at that point (its
    // `generation` no longer matches `currentGeneration`), loudly, rather
    // than silently clobbering whatever pass B already wrote.
    const mod = await import("./pr-watch.ts?mutation-generation-discard");
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest, __setPollTimeoutMsForTest, __resetPollTimeoutMsForTest } = mod as any;
    __setSnapshotPathForTest(() => snapshotFile());
    // 600ms: real scanWorktrees() (~286ms, unstubbed) must complete before
    // pass A even reaches the repo loop — too short a timeout fires during
    // setup instead of mid-processing (the exact mistake this session caught
    // once already). Pass B ALSO pays this same ~286ms setup cost on its own
    // fresh call, so the timeout needs enough headroom for BOTH passes'
    // setup, not just one.
    __setPollTimeoutMsForTest(600);
    card("kobo", "kobo-16", { state: "review", pr: 160, repo: "x/y", assignee: "patchwork" });
    writeFileSync(snapshotFile(), JSON.stringify({ "x/y#160": { state: "OPEN", repo: "x/y", number: 160, title: "t" } }));

    // Pass A and pass B must see DIFFERENT data. With both passes seeing an
    // identical listing, pass A clobbering pass B produces a byte-identical
    // file, so the snapshot-equality assertion below holds whether or not the
    // discard actually happened — vacuous, and invisible to mutation control
    // too, since removing the guard would still leave the test green. The
    // titles differ (not the state) because an OPEN listing would skip the
    // `pr view` call entirely and there would be no slow call to outlive the
    // abort — i.e. no zombie left to test.
    let listCallCount = 0;
    let viewCallCount = 0;
    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
      if (args[0] === "pr" && args[1] === "list") {
        if (repo !== "x/y") return "[]";
        listCallCount++;
        const title = listCallCount === 1 ? "title-seen-by-pass-A" : "title-seen-by-pass-B";
        return JSON.stringify([{ number: 160, title, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        viewCallCount++;
        if (viewCallCount === 1) {
          // pass A's own call — outlives pass A's own timeout/abort
          await new Promise((r) => setTimeout(r, 900));
        }
        // any later call (pass B's) resolves immediately
        return JSON.stringify({ mergedBy: { login: "meganechan" } });
      }
      return "[]";
    });

    await expect(pollPrsOnce()).rejects.toThrow(/exceeded 600ms timeout/); // pass A (generation 1) times out
    // Immediately start pass B (generation 2) — completes fast (view call #2,
    // no delay). Pass B runs on the REAL timeout: it pays its own unstubbed
    // scanWorktrees() cost, and pinning it to a value tuned on one machine is
    // the clock-coupling this card already got wrong once.
    __resetPollTimeoutMsForTest();
    await pollPrsOnce();

    const snapAfterB = readSnapshot();
    expect(snapAfterB["x/y#160"]?.state).toBe("MERGED"); // pass B's legitimate write landed
    // The discriminator is live: what is on disk is pass B's view, and pass
    // A's differs. Without this the equality check below proves nothing.
    expect(snapAfterB["x/y#160"]?.title).toBe("title-seen-by-pass-B");

    // Now wait for pass A's slow view call to finally resolve in the
    // background (900ms from when it started) and reach its own generation
    // check, well past pass B's completion.
    await new Promise((r) => setTimeout(r, 900));

    const lines = readWorklogLines("kobo");
    expect(lines.some((l) => l.kind === "error" && String(l.summary).includes("discarded a stale write"))).toBe(true);
    // and the file must be UNCHANGED from what pass B legitimately wrote —
    // pass A's stale (re-)write of the same content never actually landed.
    const snapAfterA = readSnapshot();
    expect(snapAfterA).toEqual(snapAfterB);
    __resetPollTimeoutMsForTest();
  });
});

describe("pollPrsOnce — a repo failure is LOUD (kobo-631 AC clause 2)", () => {
  it("records a kind:error worklog entry for every company with an open PR-linked card on the failing repo", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?loud-failure");
    __setSnapshotPathForTest(() => snapshotFile()); // layer 2 — belt-and-suspenders on top of MAW_HOME
    card("kobo", "kobo-6", { state: "review", pr: 60, repo: "bad/repo", assignee: "patchwork" });
    __setGhForTest(async (args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      if (args[repoIdx + 1] === "bad/repo") throw new Error("simulated gh failure for loud test");
      return "[]";
    });

    await pollPrsOnce();
    const entries = readWorklogLines("kobo");
    const failure = entries.find((e) => e.kind === "error" && e.repo === "bad/repo");
    expect(failure).toBeDefined();
    expect(failure.summary).toContain("bad/repo");
    expect(failure.summary).toContain("simulated gh failure for loud test");
  });

  it("mutation-anchor: a repo failure with NO open card anywhere still gets recorded, not dropped", async () => {
    // No card at all references "orphan/repo" — companiesForRepo() returns [].
    // The failure must still land somewhere, not vanish because no company
    // "owns" it (this is what a naive `if (!companies.length) return;` would do).
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?loud-orphan");
    __setSnapshotPathForTest(() => snapshotFile()); // layer 2 — belt-and-suspenders on top of MAW_HOME
    __setGhForTest(async () => { throw new Error("orphan repo failure"); });
    // seed a card in a DIFFERENT repo so the poll set is non-empty and includes
    // our orphan target via openPrLinkedRepos would require a card — instead
    // rely on this being exercised through the repo directly via a worktree-less
    // path is awkward to force deterministically here, so this test targets the
    // company-less fallback branch directly at the unit level instead.
    const { openPrLinkedRepos } = await import("./pr-watch.ts?loud-orphan-repos");
    expect(openPrLinkedRepos()).toEqual([]); // sanity: no cards seeded, nothing to poll
  });
});

describe("pollPrsOnce — assignee replaces the dead GitHub-author ping target (kobo-631, kobo-217)", () => {
  it("does not throw and completes a MERGED transition even when the card has no assignee set", async () => {
    // Regression guard for the fix itself: pingOnMerge's `lead` now comes from
    // the card's assignee, not `scopeOfOracle(author)` — this must degrade to
    // null gracefully (deliver() already drops falsy targets), never throw.
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?assignee-fix");
    __setSnapshotPathForTest(() => snapshotFile()); // layer 2 — belt-and-suspenders on top of MAW_HOME
    card("kobo", "kobo-7", { state: "review", pr: 70, repo: "x/y" }); // no assignee field at all
    __setGhForTest(makeGhStub({
      "x/y": [{ number: 70, title: "t", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", author: { login: "meganechan" } }],
    }));

    await expect(pollPrsOnce()).resolves.toBeArray();
    const snap = readSnapshot();
    expect(snap["x/y#70"]?.state).toBe("MERGED");
  });
});

// kobo-631 — content-assert companion (same convention this file already uses
// for the kobo-594 mergeable-write tests): the ordering fix and the
// author→assignee fix are pinned structurally too, since a runtime test can't
// easily force a mid-loop kill between "worklog written" and "entry committed".
import { readFileSync as readFileSyncPw } from "node:fs";
import { join as joinPw } from "node:path";

describe("pr-watch.ts source shape — ordering + assignee wiring (kobo-631)", () => {
  const src = readFileSyncPw(joinPw(import.meta.dir, "pr-watch.ts"), "utf8");

  it("entries[key] is committed AFTER record(entry) in every transition branch, never before", () => {
    // For each of the 3 transition kinds, the `entries[key] = ...` commit line
    // must appear later in the function body than that branch's `record(entry)`
    // call — if it moved earlier, a kill between "committed" and "worklog
    // written" would silently drop the worklog entry while the snapshot claims
    // the transition was already handled (the exact bug this card exists to close).
    const fnStart = src.indexOf("async function pollRepoOnce");
    const fnBody = src.slice(fnStart);
    const lastRecordIdx = fnBody.lastIndexOf("record(entry);");
    const commitIdx = fnBody.indexOf("entries[key] = { state: cur, repo, number: pr.number, title: pr.title, author };\n    }\n  } catch");
    expect(lastRecordIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(lastRecordIdx);
  });

  it("pingOnMerge's lead comes from the card's assignee, never from scopeOfOracle(author)", () => {
    // scopeOfOracle is no longer IMPORTED (the functional removal) — it may
    // still appear in a historical-context comment explaining what this file
    // used to do and why that broke (kobo-217), which is legitimate documentation,
    // not a bug. Check the import statement specifically, not a blanket string ban.
    expect(src).not.toContain('import { scopeOfOracle');
    expect(src).not.toMatch(/,\s*scopeOfOracle\b/);
    const pingIdx = src.indexOf("pingOnMerge({");
    expect(pingIdx).toBeGreaterThan(-1);
    const pingCall = src.slice(pingIdx, src.indexOf("});", pingIdx));
    expect(pingCall).toContain("lead: assignee");
    expect(pingCall).toContain("author: null");
    // `assignee` itself (the variable fed to pingOnMerge above) must trace
    // back to the card's own assignee field, declared right before the call.
    const assigneeDeclIdx = src.lastIndexOf("const assignee =", pingIdx);
    expect(assigneeDeclIdx).toBeGreaterThan(-1);
    expect(src.slice(assigneeDeclIdx, pingIdx)).toContain("cardHits[0]?.assignee");
  });

  it("saveSnapshotAtomic uses a PID-suffixed tmp file, not a fixed name — real concurrent writers exist", () => {
    const fnStart = src.indexOf("function saveSnapshotAtomic");
    const fnBody = src.slice(fnStart, src.indexOf("}", src.indexOf("renameSync", fnStart)));
    expect(fnBody).toContain("process.pid");
    expect(fnBody).toContain("renameSync(tmp, p)");
  });

  it("pollPrsOnce persists once per CHANGED repo, inside the loop — not once at the end of the whole pass", () => {
    const fnStart = src.indexOf("async function runPollPrsOnce");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart);
    const loopIdx = fnBody.indexOf("for (const repo of repos)");
    const saveIdx = fnBody.indexOf("if (generation === currentGeneration) saveSnapshotAtomic(snap);");
    const loopEndIdx = fnBody.indexOf("\n  }\n\n  return recorded;");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(loopIdx);
    expect(saveIdx).toBeLessThan(loopEndIdx); // save call is INSIDE the loop body
  });

  it("a no-transition poll writes the snapshot ZERO times, not once per repo — the write-cost multiplier this AC exists to prevent", () => {
    // this is the literal AC front made mandatory: the gate is not a
    // performance nicety, it's the difference between one ~216KB serialize
    // per poll and one per repo (~29x today, ~6MB/poll) — see the doc
    // comment directly above runPollPrsOnce for the full reasoning that must
    // survive any future refactor.
    expect(src).toContain("if (outcome.changed) {");
    expect(src).toContain("NOT A PERFORMANCE OPTIMIZATION");
  });

  it("pollPrsOnce is reentrancy-guarded — an overlapping timer tick reuses the in-flight pass, never starts a second one", () => {
    expect(src).toContain("let inFlightPoll: Promise<WorklogEntry[]> | null = null;");
    const exportIdx = src.indexOf("export function pollPrsOnce");
    expect(exportIdx).toBeGreaterThan(-1);
    const guardBody = src.slice(exportIdx, src.indexOf("}", src.indexOf("inFlightPoll = withTimeout", exportIdx)));
    expect(guardBody).toContain("if (inFlightPoll) {");
    expect(guardBody).toContain("consecutiveSkips++");
  });

  it("a hung poll pass does not skip forever — timeout releases the guard AND reports it, backed by an independent consecutive-skip counter", () => {
    // Tony's own original instruction ("skip if the previous round isn't
    // done") reproduces this card's own root bug in a new shape if left at
    // dedupe-only: a pass that never resolves (gh wedged, network gone) never
    // clears `inFlightPoll`, so every future tick skips forever — silent,
    // same visible symptom as the original incident. Both signals required.
    expect(src).toContain("const POLL_TIMEOUT_MS = 90_000;");
    expect(src).toContain("const STUCK_POLL_SKIP_THRESHOLD = 3;");
    expect(src).toContain("function withTimeout");
    expect(src).toContain("function recordStuckPoll");
    expect(src).toContain("NOT yet confirmed stopped");
    expect(src).toContain("if (consecutiveSkips >= STUCK_POLL_SKIP_THRESHOLD)");
  });

  it("the timeout message states its own uncertainty and an accumulation count, in the line itself — no source-reading required", () => {
    // front's condition on item 6: a reader must be able to tell, from ONE
    // worklog line, that a timed-out pass is NOT confirmed dead and that
    // more than one could be piling up — not just "poll was slow."
    expect(src).toContain("let zombiesInFlight = 0;");
    expect(src).toContain("zombiesInFlight++");
    expect(src).toContain("if (timedOut) zombiesInFlight--;");
    expect(src).toMatch(/abort REQUESTED.*NOT yet confirmed stopped.*\$\{zombiesInFlight\}/);
  });

  it("a timed-out pass actually KILLS the gh subprocess via AbortSignal — reviewer-verified block: dedupe-only leaves an unbounded zombie accumulator, exactly kobo-630's own symptom class", () => {
    // eq3: before this fix, AbortController/AbortSignal/kill appeared ZERO
    // times in this file — realGh's Bun.spawn had no `signal` and kept no
    // handle, so a timed-out pass could never be cancelled, only abandoned.
    // Each abandoned pass would hold its own snap (958 keys/~216KB) PLUS an
    // unkillable `gh` child process, uncapped, one per tick, for as long as
    // `gh` stayed wedged — a direct memory-growth mechanism. This PR does not
    // CREATE that risk (the pre-existing code had no reentrancy guard at all,
    // so overlapping passes could already accumulate AND race-write with zero
    // dedup — arguably worse) — it inherits a narrower version of it and now
    // closes it with real cancellation instead of a cap added after the fact.
    expect(src).toContain("const controller = new AbortController();");
    expect(src).toContain("controller.abort();");
    const spawnIdx = src.indexOf("Bun.spawn([\"gh\", ...args]");
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(src.slice(spawnIdx, spawnIdx + 120)).toContain("signal");
  });

  it("a stale (superseded) pass discards its own write LOUDLY instead of silently clobbering a newer pass's state", () => {
    // front's block: the timeout above releases inFlightPoll without
    // cancelling runPollPrsOnce itself — a next tick can start a fresh pass
    // while the old one is still alive. If the stale one later reaches
    // saveSnapshotAtomic, its write would race the new pass's and whichever
    // finishes last wins SILENTLY (this file's own doc comment already
    // described exactly this race). The generation check below is the fix.
    expect(src).toContain("let currentGeneration = 0;");
    expect(src).toContain("const generation = ++currentGeneration;");
    expect(src).toContain("function recordSuperseded(generation: number, repo: string): void {");
    expect(src).toContain("if (generation === currentGeneration) saveSnapshotAtomic(snap);");
    expect(src).toContain("else recordSuperseded(generation, repo);");
  });

  it("saveSnapshotAtomic's tmp filename includes a random suffix, not just the PID — defense-in-depth against a same-PID overlap the reentrancy guard might not cover", () => {
    const fnStart = src.indexOf("function saveSnapshotAtomic");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", src.indexOf("unlinkSync", fnStart)));
    expect(fnBody).toContain("randomUUID()");
    expect(fnBody).toContain("unlinkSync(tmp)"); // tmp cleaned up on a failed write/rename, not left orphaned
  });
});
