import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { spawnHeyProcess } from "./hey-spawn";

// kobo-405 — exploit-reality: prove the fail-closed test preload
// (bunfig.toml → test/helpers/hey-spawn-fail-closed.ts) is what's actually
// standing between a test and a real `maw hey` subprocess, without ever
// spawning a real one.
describe("hey-spawn (kobo-405)", () => {
  test("the global test preload replaces spawnHeyProcess with a fail-closed stub", () => {
    // If the preload is ever removed or broken (bunfig.toml entry deleted, the
    // setup file deleted/mis-scoped), this import resolves to the REAL
    // implementation below — this call would then either throw a different
    // error (a real subprocess spawn with a bogus argv) or, worse, silently
    // shell out. Either way this assertion breaks, which is the tripwire: it
    // fails loudly instead of a test quietly firing a live hey.
    expect(() => spawnHeyProcess(["--channel", "task-events", "some-oracle", "boom"]))
      .toThrow(/kobo-405: a test attempted a REAL `maw hey` spawn/);
  });

  test("the REAL (unmocked) implementation on disk really shells out to `maw hey` — what the preload stands in front of", () => {
    // Source-contract check rather than a live call: proves spawnHeyProcess's
    // actual production body is a genuine Bun.spawn(["maw","hey",...]) call —
    // i.e. the preload isn't guarding a no-op, it's guarding a real spawn.
    const src = readFileSync(new URL("./hey-spawn.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/Bun\.spawn\(\s*\[\s*"maw",\s*"hey",\s*\.\.\.args\s*\]/);
  });
});
