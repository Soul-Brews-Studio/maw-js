import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

// kobo-364 plugin-coverage-gate: the `head` plugin is a MODULE surface
// (mirrors home/worklog/task/crew — `runHead` invoked by `maw company head`,
// not a top-level command). It shells hostExec (tmux) + reads oracle/company
// config on purpose — this test pins exactly which boundaries it may cross,
// so extraction/refactor drift is visible instead of silent.

describe("head command plugin standalone boundary", () => {
  test("head keeps explicit import boundaries (SDK + maw-js/config + core/worklog/company-scope)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "head",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [/^(?:\.\.\/){3}core\/worklog\//],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
    expect(imports).toContain("maw-js/config");
  });

  test("module surface only — no top-level `cli.command` (mirrors home/worklog/task/crew, cli-reorg pattern)", () => {
    const pluginSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/plugin.ts"), "utf8");
    expect(pluginSrc).not.toContain("cli:");
    expect(pluginSrc).toContain('"exports": ["runHead"]');
  });

  test("index.ts exports runHead(args, emit) — the shared runner contract (home/task/crew pattern)", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/index.ts"), "utf8");
    expect(indexSrc).toContain("export async function runHead");
    expect(indexSrc).toContain('subcmd === "spawn"');
    expect(indexSrc).toContain("headSpawn");
  });

  test("spawn.ts: head cell = lead + conductor + reviewer, both spawned roles opus, NO worker window (head ≠ crew)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("--model opus");
    expect(spawnSrc).not.toContain("hostExec(`tmux new-window"); // no worker window ever EXECUTED (not just mentioned in doc prose)
    expect(spawnSrc).not.toContain('"claude-sonnet-5"'); // not a crew worker spawn (string literal, not doc prose)
  });

  // eq3 kobo-364 ruling: self-heal does NOT apply the same way as crew's — head
  // is opus-only with no blessed fallback tier. Pin poll-verify-boot-ONLY,
  // never a retry-with-a-different-model step.
  test("spawn.ts: poll-verify-boot ONLY — no fallback-to-cheaper-model retry (opus-only strategic tier)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("pollBoot");
    expect(spawnSrc).not.toContain("FALLBACK_"); // no fallback-model constant (crew has FALLBACK_WORKER_MODEL)
    expect(spawnSrc).not.toContain('"sonnet"'); // no cheaper-tier model string literal anywhere in the spawn logic
    expect(spawnSrc).not.toContain("tmux kill-window"); // no orphan-kill-then-retry cycle (no retry at all)
  });

  // kobo-364 empirical finding (live dogfood): a 3-way split makes the
  // reviewer pane narrow enough (~19 cols observed) that the CC TUI's "bypass
  // permissions on" footer truncates — a width-bound substring check
  // FALSE-NEGATIVEs a pane that genuinely booted. Pin the width-independent
  // "❯" prompt-marker fallback this fix added (crew's worker check never
  // needed this — `tmux new-window` gives it a full-width pane, not a split).
  test("spawn.ts: boot-detection has a width-independent fallback (❯ prompt marker) for narrow split panes", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("BOOT_READY_RE");
    expect(spawnSrc).toMatch(/bypass permissions.*\|\|.*BOOT_READY_RE|BOOT_READY_RE.*\|\|.*bypass permissions/s);
  });

  test("spawn.ts: boot-fail is LOUD — maw hey to a RESOLVED lead addr, not a bare pane-id, not just a log line", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("#{session_name}:#{window_index}.#{pane_index}");
    expect(spawnSrc).toContain("notifyBootFailLoud");
    expect(spawnSrc).toContain("maw hey");
  });

  test("spawn.ts: a boot-fail on either role is a HARD STOP (returns ok:false) — no partial-cell silent success", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/spawn.ts"), "utf8");
    const conductorFailIdx = spawnSrc.indexOf("conductorBooted");
    const reviewerFailIdx = spawnSrc.indexOf("reviewerBooted");
    expect(conductorFailIdx).toBeGreaterThan(-1);
    expect(reviewerFailIdx).toBeGreaterThan(-1);
    // both paths return { ok: false, ... } — not a "pane stays up, ok:true" shape like crew's worker double-fail
    const conductorBlock = spawnSrc.slice(conductorFailIdx, reviewerFailIdx);
    expect(conductorBlock).toContain("ok: false");
  });

  test("spawn.ts reuses crew/teardown.ts's teardownCrewWindows AS-IS (no copy, no reimplementation)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/head/spawn.ts"), "utf8");
    expect(spawnSrc).toContain('from "../crew/teardown"');
    expect(spawnSrc).toContain("teardownCrewWindows");
  });

  test("company/index.ts wires `head` to runHead (the CLI seam)", () => {
    const companyIndexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(companyIndexSrc).toContain('from "../head/index"');
    expect(companyIndexSrc).toContain("runHead");
    expect(companyIndexSrc).toContain('=== "head"');
  });

  // kobo-366: closed the manager-repair gap 364 deferred — company-fleet.ts's
  // existing ready-check (👤+🎼+🔎) already matched this verb's output (364's
  // load-bearing claim, still true), so `up` now REPAIRS an incomplete manager
  // head-cell via the same inject-via-send-keys pattern crew-tier already uses
  // (`maw company head spawn <co>`, injected — NOT a direct in-process runHead
  // call, since headSpawn reads its OWN pane's TMUX_PANE and must run from
  // inside it).
  test("company-fleet.ts repairs an incomplete manager head-cell via injected `maw company head spawn` (kobo-366)", () => {
    const fleetSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/company-fleet.ts"),
      "utf8",
    );
    expect(fleetSrc).toContain("maw company head spawn");
    expect(fleetSrc).not.toContain("no head-spawn verb yet"); // the old report-only carve-out is gone
    expect(fleetSrc).not.toContain("runHead"); // still injected via tmux send-keys, never called in-process
  });

  test("contract asset templates exist (conductor+reviewer, NO lead.md) and are shipped by crew-skills sync", () => {
    const contractsDir = join(
      import.meta.dir,
      "../../src/vendor/mpr-plugins/crew-skills/assets/skills/head/contracts",
    );
    for (const role of ["conductor", "reviewer"]) {
      const tpl = readFileSync(join(contractsDir, `${role}.md`), "utf8");
      expect(tpl).toContain("{{COMPANY}}");
    }
    const syncSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/crew-skills/sync.ts"),
      "utf8",
    );
    expect(syncSrc).toContain("skills/head/contracts/conductor.md");
    expect(syncSrc).toContain("skills/head/contracts/reviewer.md");
    expect(syncSrc).not.toContain("skills/head/contracts/lead.md"); // lead is never spawned, no contract needed
  });
});
