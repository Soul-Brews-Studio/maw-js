import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

// #2316 plugin-coverage-gate: the worklog engine lives in src/core/worklog/* +
// the feed singleton (src/api/feed). The `watch` plugin is its thin CLI + serve
// shell, so those deep imports are the EXPLICIT, intended coupling — this test
// pins exactly which boundary the shell is allowed to cross, so extraction drift
// is visible instead of silently breaking implementation-coverage mocks.

describe("watch command plugin standalone boundary", () => {
  test("watch keeps explicit import boundaries (SDK + the core/worklog engine it shells)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "watch",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [/^(?:\.\.\/){3}core\/worklog\//, /^(?:\.\.\/){3}api\/feed$/],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("serve hook wires the engine (route + capture listener) so it toggles with the plugin", () => {
    // Static read — NOT a dynamic import — so a sibling test's mock.module of
    // maw-js/sdk (which api/feed pulls in) can't bleed in and break evaluation.
    const serveSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/serve.ts"),
      "utf8",
    );
    expect(serveSrc).toContain("registerWorklogListener");
    expect(serveSrc).toContain("/api/worklog");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["']/);
  });
});
