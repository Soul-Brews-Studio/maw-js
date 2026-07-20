import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

// kobo-358 plugin-coverage-gate: the `crew` plugin is a MODULE surface
// (mirrors home/worklog/task — `runCrew` invoked by `maw company crew`, not a
// top-level command). It shells hostExec (tmux) + reads oracle/company config
// on purpose — this test pins exactly which boundaries it may cross, so
// extraction/refactor drift is visible instead of silent.

describe("crew command plugin standalone boundary", () => {
  test("crew keeps explicit import boundaries (SDK + maw-js/config + core/worklog/company-scope)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "crew",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [/^(?:\.\.\/){3}core\/worklog\//],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
    expect(imports).toContain("maw-js/config");
  });

  test("module surface only — no top-level `cli.command` (mirrors home/worklog/task, cli-reorg pattern)", () => {
    const pluginSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/plugin.ts"), "utf8");
    expect(pluginSrc).not.toContain("cli:");
    expect(pluginSrc).toContain('"exports": ["runCrew"]');
  });

  test("index.ts exports runCrew(args, emit) — the shared runner contract (home/task pattern)", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/index.ts"), "utf8");
    expect(indexSrc).toContain("export async function runCrew");
    expect(indexSrc).toContain('subcmd === "spawn"');
    expect(indexSrc).toContain("crewSpawn");
  });

  test("spawn.ts: worker defaults to the literal claude-sonnet-5 (kobo-358 Tony directive — not normalized)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/spawn.ts"), "utf8");
    expect(spawnSrc).toContain('DEFAULT_WORKER_MODEL = "claude-sonnet-5"');
    expect(spawnSrc).toContain('FALLBACK_WORKER_MODEL = "sonnet"');
  });

  test("spawn.ts: self-heal poll-verify + kill-orphan-then-retry present (ported from kobo-352)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("pollBoot");
    expect(spawnSrc).toContain("tmux kill-window");
    expect(spawnSrc).toMatch(/spawnWorkerSelfHeal/);
  });

  test("spawn.ts: double-fail notify resolves a session:window.pane addr, not a bare pane-id (kobo-354/355 lesson)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("#{session_name}:#{window_index}.#{pane_index}");
    expect(spawnSrc).toContain("frontAddr");
  });

  test("teardown.ts: session-scoped (list-panes -s), never server-wide -a — protects other oracles' live crew cells", () => {
    const teardownSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/teardown.ts"), "utf8");
    expect(teardownSrc).toContain("tmux list-panes -s -t");
    expect(teardownSrc).not.toMatch(/tmux list-panes -a\b/);
  });

  test("teardown.ts: front/coord role is never kill-eligible; conductor/worker/reviewer + crew-workers window are", () => {
    const teardownSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/teardown.ts"), "utf8");
    expect(teardownSrc).not.toContain('"🧭"');
    expect(teardownSrc).toContain('"🎼"');
    expect(teardownSrc).toContain('"⚒"');
    expect(teardownSrc).toContain('"🔎"');
    expect(teardownSrc).toContain("crew-workers");
  });

  // kobo-362 SAFETY FIX: an empty `-t` tmux target silently resolves to the
  // CALLER's own current session (not an error) — a caller passing an empty
  // protectPaneId would sweep the WRONG session's crew panes. Pin the guard
  // fires BEFORE the resolve, not just as an incidental empty-string check
  // somewhere downstream.
  test("teardown.ts: refuses fail-closed on an empty protectPaneId, BEFORE any tmux resolve call", () => {
    const teardownSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/crew/teardown.ts"), "utf8");
    const guardIdx = teardownSrc.indexOf("empty protectPaneId");
    const resolveIdx = teardownSrc.indexOf("hostExec(`tmux display-message"); // the actual call, not the explanatory comment prose
    expect(guardIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(resolveIdx); // the guard is textually BEFORE the dangerous resolve call
  });

  test("company/index.ts wires `crew` to runCrew (the CLI seam)", () => {
    const companyIndexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(companyIndexSrc).toContain('from "../crew/index"');
    expect(companyIndexSrc).toContain("runCrew");
    expect(companyIndexSrc).toContain('=== "crew"');
  });

  test("contract asset templates exist and are shipped by crew-skills sync", () => {
    const contractsDir = join(
      import.meta.dir,
      "../../src/vendor/mpr-plugins/crew-skills/assets/skills/crew/contracts",
    );
    for (const role of ["conductor", "worker", "reviewer"]) {
      const tpl = readFileSync(join(contractsDir, `${role}.md`), "utf8");
      expect(tpl).toContain("{{COMPANY}}");
    }
    const syncSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/crew-skills/sync.ts"),
      "utf8",
    );
    expect(syncSrc).toContain("skills/crew/contracts/conductor.md");
    expect(syncSrc).toContain("skills/crew/contracts/worker.md");
    expect(syncSrc).toContain("skills/crew/contracts/reviewer.md");
  });
});
