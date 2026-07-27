/**
 * kobo-481 — real, unmocked tests. This file is deliberately NOT
 * core/tasks/hey-spawn.ts (which the kobo-405 fail-closed preload replaces
 * for every test in the repo) — logHeySpawnFailure/watchHeySpawnForFailure
 * live in this sibling file specifically so they can be imported and
 * exercised directly here, no module-mock override needed to reach them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logHeySpawnFailure, watchHeySpawnForFailure, type HeySpawnWatchTarget } from "./hey-spawn-failure-log";

function stderrStreamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

describe("logHeySpawnFailure (kobo-481)", () => {
  let errSpy: ReturnType<typeof spyConsoleError>;
  function spyConsoleError() {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { calls.push(args); };
    return { calls, restore: () => { console.error = original; } };
  }
  beforeEach(() => { errSpy = spyConsoleError(); });
  afterEach(() => { errSpy.restore(); });

  test("prints the args, exit code, and stderr text", () => {
    logHeySpawnFailure(["--channel", "task-events", "eq3", "hi"], 1, "refuse: not in company");
    expect(errSpy.calls).toHaveLength(1);
    const printed = String(errSpy.calls[0][0]);
    expect(printed).toContain("--channel task-events eq3 hi");
    expect(printed).toContain("exit 1");
    expect(printed).toContain("refuse: not in company");
  });

  test("falls back to a placeholder when stderr is empty", () => {
    logHeySpawnFailure(["eq3", "hi"], 1, "");
    expect(String(errSpy.calls[0][0])).toContain("(no stderr captured)");
  });
});

describe("watchHeySpawnForFailure (kobo-481) — this IS the real path spawnHeyProcess wires up, exercised with a real (not fake-target-fails-early) failing subprocess shape", () => {
  let originalConsoleError: typeof console.error;
  const calls: unknown[][] = [];
  beforeEach(() => {
    calls.length = 0;
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { calls.push(args); };
  });
  afterEach(() => { console.error = originalConsoleError; });

  test("a genuinely non-zero exit gets logged, with the real captured stderr", async () => {
    const target: HeySpawnWatchTarget = {
      exited: Promise.resolve(1),
      stderr: stderrStreamOf("could not resolve a real sender identity"),
    };
    await watchHeySpawnForFailure(target, ["eq3", "hello"]);
    expect(calls).toHaveLength(1);
    const printed = String(calls[0][0]);
    expect(printed).toContain("exit 1");
    expect(printed).toContain("could not resolve a real sender identity");
  });

  test("AC: success (exit 0) adds NO noise — this is the branch a caller must reach, not skip past", async () => {
    const target: HeySpawnWatchTarget = { exited: Promise.resolve(0), stderr: stderrStreamOf("") };
    await watchHeySpawnForFailure(target, ["eq3", "hello"]);
    expect(calls).toHaveLength(0);
  });

  test("a failure to even learn the exit code (exited promise rejects) never throws into a fire-and-forget caller", async () => {
    const target: HeySpawnWatchTarget = { exited: Promise.reject(new Error("proc handle gone")), stderr: undefined };
    await expect(watchHeySpawnForFailure(target, ["eq3", "hello"])).resolves.toBeUndefined();
    expect(calls).toHaveLength(0); // nothing to report if we can't even learn the code
  });

  test("stderr is genuinely a number (Bun's 'ignore'/fd shape), not a stream — still reports the failure without stderr detail, doesn't crash", async () => {
    const target: HeySpawnWatchTarget = { exited: Promise.resolve(1), stderr: -1 };
    await watchHeySpawnForFailure(target, ["eq3", "hello"]);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain("(no stderr captured)");
  });
});
