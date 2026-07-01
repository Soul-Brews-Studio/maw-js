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
      allowRelative: [
        /^(?:\.\.\/){3}core\/worklog\//,
        /^(?:\.\.\/){3}core\/tasks\//, // company-ui board (stub now, backbone later)
        /^(?:\.\.\/){3}core\/state-doc\//, // company-ui coordination markdown panel
        /^(?:\.\.\/){3}core\/policy\//, // policy inject route — on-attach context
        /^(?:\.\.\/){3}api\/feed$/,
      ],
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
    expect(serveSrc).toContain("/api/policy");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["']/);
  });

  test("serve hook also wires the company-ui read-only routes (feed timeline + board)", () => {
    const serveSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/serve.ts"),
      "utf8",
    );
    // company-ui (spec §6) reads these two from the same plugin so they toggle
    // with the worklog engine; backbone replaces the /api/tasks stub later.
    expect(serveSrc).toContain("/api/worklog/feed");
    expect(serveSrc).toContain("/api/tasks");
    expect(serveSrc).toContain("/api/state");
    expect(serveSrc).toContain("handleWorklogFeedRequest");
    expect(serveSrc).toContain("handleTasksRequest");
    expect(serveSrc).toContain("handleStateDocRequest");
  });

  test("watch menu is hidden from help but still callable (deprecation shim)", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/plugin.json"), "utf8"),
    );
    // hidden:true removes it from `maw` help; cli.command still present so the
    // `maw watch <sub>` deprecation shim keeps dispatching for one release.
    expect(manifest.cli.hidden).toBe(true);
    expect(manifest.cli.command).toBe("watch");
    expect(manifest.cli.help).toMatch(/DEPRECATED/);
    // ensures advertises the company-ui routes alongside the worklog/policy ones.
    expect(manifest.hooks.serve.ensures).toContain("http:route:/api/worklog/feed");
    expect(manifest.hooks.serve.ensures).toContain("http:route:/api/tasks");
    expect(manifest.hooks.serve.ensures).toContain("http:route:/api/state");
  });

  // cli-reorg (ADR docs/company/0001): dispatch is a shared `runWorklog` runner
  // so `maw company worklog` (company plugin) and the top-level `maw watch` shim
  // share ONE copy. All verbs preserved (OQ2 — no cull). Serve hook untouched.
  test("exports a shared runWorklog runner (all verbs) and the top-level handler is a deprecation shim", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/index.ts"),
      "utf8",
    );
    expect(src).toContain("export async function runWorklog");
    expect(src).toContain("moved → 'maw company worklog'"); // shim notice
    expect(src).toContain("await runWorklog("); // handler forwards to the shared runner
    for (const verb of ['subcmd === "log"', 'subcmd === "inject"', 'subcmd === "claim"', 'subcmd === "release"', 'subcmd === "sync"', 'subcmd === "setup-hooks"']) {
      expect(src).toContain(verb);
    }
  });
});
