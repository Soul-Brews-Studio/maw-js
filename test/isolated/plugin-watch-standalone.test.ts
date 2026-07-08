import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";

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
        /^(?:\.\.\/){3}core\/roster\//, // company-ui presence roster (kobo-50)
        /^(?:\.\.\/){3}core\/presence\//, // company-ui presence detail — per-pane model + ctx% (kobo-104)
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
    // kobo-207: card-detail live-push SSE stream (GET), on the same plugin so it
    // toggles with the board it streams.
    expect(serveSrc).toContain("handleTaskEventsRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/tasks\/events["']/);
    // kobo-35: per-card archive write route (POST) lives on the same plugin so it
    // toggles with the worklog engine + the board it mutates.
    expect(serveSrc).toContain("handleTaskArchiveRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/archive["']/);
    // kobo-46: web comment POST → append note + poke assignee (task-events).
    expect(serveSrc).toContain("handleTaskNoteRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/note["']/);
    // kobo-141: threaded comment POST + resolve POST (ask/answer channel).
    expect(serveSrc).toContain("handleTaskCommentRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/comment["']/);
    expect(serveSrc).toContain("handleTaskResolveRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/resolve["']/);
    // kobo-48: web create POST → +subtask (child card, epic = parent).
    expect(serveSrc).toContain("handleTaskCreateRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/create["']/);
    // kobo-50: mark-done POST (guard b web trigger) + presence roster GET.
    expect(serveSrc).toContain("handleTaskDoneRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/done["']/);
    // kobo-192: approve POST — derives from pr (mark-only vs spawn execution-card).
    expect(serveSrc).toContain("handleTaskApproveRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/tasks\/approve["']/);
    expect(serveSrc).toContain("handleRosterRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/roster["']/);
    // kobo-104: per-pane presence detail GET (model + context%).
    expect(serveSrc).toContain("handlePresenceRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/presence["']/);
    // kobo-57: cache-bust version GET — the board polls it to detect a new deploy
    // and offer a reload. Served from companyVersion() (content hash of the board).
    expect(serveSrc).toContain("companyVersion");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/version["']/);
  });

  // cli-reorg kobo-26: `maw watch` is HARD-REMOVED (no cli command). The plugin
  // keeps its serve hook (HTTP routes) — hooks make it non-dispatchable as a
  // command — and exposes `runWorklog` as a module for `maw company worklog`.
  // Authoritative manifest via loadManifestFromDir (plugin.ts-first) — guards
  // against plugin.ts/json drift hiding a still-registered `maw watch` (kobo-26).
  test("no cli command (maw watch → unknown), serve hook + module surface intact", () => {
    const manifest = loadManifestFromDir(join(import.meta.dir, "../../src/vendor/mpr-plugins/watch"))!.manifest;
    expect(manifest.cli).toBeUndefined(); // hard-removed — not dispatchable as `maw watch`
    expect(manifest.module?.exports).toContain("runWorklog"); // company imports this
    // serve hook untouched — the worklog/board HTTP routes still toggle with the plugin.
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/worklog/feed");
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks");
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/events"); // kobo-207
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/archive"); // kobo-35
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/note"); // kobo-46
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/comment"); // kobo-141
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/resolve"); // kobo-141
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/create"); // kobo-48
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/tasks/done"); // kobo-50
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/roster"); // kobo-50
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/presence"); // kobo-104
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/state");
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/version"); // kobo-57 cache-bust
  });

  // cli-reorg kobo-26: exports the shared `runWorklog` runner (all verbs, OQ2 —
  // no cull), imported by the company plugin. No default handler / no shim.
  test("exports runWorklog (all verbs) with no shim handler / no default export", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/index.ts"),
      "utf8",
    );
    expect(src).toContain("export async function runWorklog");
    expect(src).not.toContain("export default"); // no top-level command handler
    expect(src).not.toContain("moved →"); // no deprecation shim notice
    for (const verb of ['subcmd === "log"', 'subcmd === "inject"', 'subcmd === "claim"', 'subcmd === "release"', 'subcmd === "sync"', 'subcmd === "setup-hooks"']) {
      expect(src).toContain(verb);
    }
  });

  // kobo-216 — `watch log` resolves its company through the STRICT resolver: --company
  // wins, else a multi-company oracle throws "ambiguous … specify --company" (option-a).
  test("company resolution uses companyOfOracleStrict (kobo-216 option-a)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/index.ts"),
      "utf8",
    );
    expect(src).toContain("companyOfOracleStrict");
  });
});
