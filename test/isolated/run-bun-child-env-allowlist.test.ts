/**
 * kobo-482 — runBunChild's spawned child must not inherit the calling
 * shell's ambient env wholesale. Only an explicit allow-list (what the
 * child bun process needs to run at all: PATH/HOME/TMPDIR/TMP/TEMP) plus
 * whatever the caller explicitly declares via opts.env should reach it.
 *
 * The AC's own wording: prove this from a genuinely dirty shell vs a clean
 * one, not by asserting inside one shell. We can't spawn two real shells
 * from inside a single bun:test run, so the dirty/clean comparison is done
 * the other way around: plant a var that no allow-list entry and no
 * opts.env declares (a stand-in for "whatever junk happens to be set in
 * whoever's terminal"), and prove it never reaches the child — the result
 * is byte-identical whether or not that var is present, which is the
 * property the AC actually cares about (test outcome independent of the
 * runner's ambient shell state).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runBunChild } from "./helpers/run-bun-child";

const POISON_KEY = "MAW_KOBO482_POISON_VAR";

const DUMP_ENV_SCRIPT = `console.log("ENV:" + JSON.stringify(process.env));`;

afterEach(() => {
  delete process.env[POISON_KEY];
});

describe("runBunChild — env allow-list (kobo-482)", () => {
  test("an ambient var set only in the calling shell (not allow-listed, not declared) never reaches the child", () => {
    process.env[POISON_KEY] = "leaked-secret-value";

    const { stdout } = runBunChild({ script: DUMP_ENV_SCRIPT });
    const childEnv = JSON.parse(stdout.slice(stdout.indexOf("ENV:") + 4)) as Record<string, string>;

    expect(childEnv).not.toHaveProperty(POISON_KEY);
    expect(stdout).not.toContain("leaked-secret-value");
  });

  test("dirty shell (poison var present) and clean shell (absent) produce identical child-visible results", () => {
    const clean = runBunChild({ script: DUMP_ENV_SCRIPT, env: { MAW_TEST_MODE: "1" } });

    process.env[POISON_KEY] = "some-value-that-must-not-matter";
    const dirty = runBunChild({ script: DUMP_ENV_SCRIPT, env: { MAW_TEST_MODE: "1" } });

    const cleanEnv = JSON.parse(clean.stdout.slice(clean.stdout.indexOf("ENV:") + 4)) as Record<string, string>;
    const dirtyEnv = JSON.parse(dirty.stdout.slice(dirty.stdout.indexOf("ENV:") + 4)) as Record<string, string>;
    delete cleanEnv.MAW_CHILD_RESULT_FILE;
    delete dirtyEnv.MAW_CHILD_RESULT_FILE;

    expect(dirtyEnv).toEqual(cleanEnv);
  });

  test("allow-listed vars (PATH, HOME) still reach the child — the fix drops ambient junk, not what the child needs to run", () => {
    const { stdout } = runBunChild({ script: DUMP_ENV_SCRIPT });
    const childEnv = JSON.parse(stdout.slice(stdout.indexOf("ENV:") + 4)) as Record<string, string>;

    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.HOME).toBe(process.env.HOME);
  });

  test("caller-declared opts.env still flows through explicitly — allow-list only blocks UNdeclared ambient vars", () => {
    const { stdout } = runBunChild({
      script: DUMP_ENV_SCRIPT,
      env: { MAW_HOME: "/tmp/declared-explicitly" },
    });
    const childEnv = JSON.parse(stdout.slice(stdout.indexOf("ENV:") + 4)) as Record<string, string>;

    expect(childEnv.MAW_HOME).toBe("/tmp/declared-explicitly");
  });
});
