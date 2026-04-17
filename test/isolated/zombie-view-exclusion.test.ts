import { describe, test, expect, mock } from "bun:test";
import type { TmuxPane } from "../../src/sdk";

// Regression test for #393 Bug F — `maw cleanup --zombie-agents` was
// flagging live fleet oracles whose canonical listing was a `*-view`
// session. The hardcoded "maw-view" literal didn't cover per-oracle
// views like `mawjs-view`, `mawui-view`, etc. Would have killed live
// oracles on `--yes`.
//
// Surfaced by zombie-auditor in iter 3 of the test loop (cron 93ad2418,
// 2026-04-17 10:26) with full evidence at
// ψ/memory/traces/2026-04-17/1026_zombie-auditor-findings.md.

// Mock fleet-load BEFORE importing findZombiePanes — FLEET_DIR is bound
// at module init time via env var, so we can't use a temp-dir approach
// once another test has already imported paths.ts. Mock the helper instead.
mock.module("../../src/commands/shared/fleet-load", () => ({
  loadFleetEntries: () => [
    { file: "101-mawjs.json", data: { name: "mawjs", windows: [] } },
    { file: "112-fusion.json", data: { name: "fusion", windows: [] } },
  ],
  loadFleetData: () => [],
}));

// Also need ~/.claude/teams/ to exist (or not trip up knownTeamPaneIds
// scan). Import AFTER mock.module.
const { findZombiePanes } = await import("../../src/commands/plugins/team/team-cleanup-zombies");

describe("findZombiePanes — view-session exclusion (#393 Bug F)", () => {
  test("pane linked only via *-view session (canonical listing is view) is NOT a zombie", () => {
    // This is exactly the iter-3 violation shape: %717 canonical listing
    // via `mawjs-view:0.0`, not `101-mawjs:0.0`.
    const panes: TmuxPane[] = [
      { id: "%717", target: "mawjs-view:0.0", command: "claude", title: "cross-node-dig-deep" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies).toEqual([]);
  });

  test("pane with duplicate listings (fleet + view) — either path is safe", () => {
    // When tmux links a pane, listPanes may return it multiple times.
    // defense-in-depth: safe if ANY listing is fleet/view.
    const panes: TmuxPane[] = [
      { id: "%717", target: "101-mawjs:0.0", command: "claude", title: "fleet listing" },
      { id: "%717", target: "mawjs-view:0.0", command: "claude", title: "view listing" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies).toEqual([]);
  });

  test("actual orphan (no fleet, no view, no team) IS flagged", () => {
    const panes: TmuxPane[] = [
      { id: "%999", target: "some-random-session:0.0", command: "claude", title: "orphan" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies.length).toBe(1);
    expect(zombies[0]?.paneId).toBe("%999");
  });

  test("bash-running pane is never a zombie (not claude)", () => {
    const panes: TmuxPane[] = [
      { id: "%200", target: "random-session:0.0", command: "bash", title: "" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies).toEqual([]);
  });

  test("legacy literal 'maw-view' still protected", () => {
    const panes: TmuxPane[] = [
      { id: "%100", target: "maw-view:0.0", command: "claude", title: "legacy" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies).toEqual([]);
  });

  test("*-view pattern: mawui-view / whitekeeper-view / arbitrary-view all protected", () => {
    const panes: TmuxPane[] = [
      { id: "%101", target: "mawui-view:0.0", command: "claude", title: "mawui view" },
      { id: "%102", target: "whitekeeper-view:0.0", command: "claude", title: "wk view" },
      { id: "%103", target: "arbitrary-view:0.0", command: "claude", title: "arb view" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies).toEqual([]);
  });

  test("-view as prefix does NOT match (safety: only suffix pattern protected)", () => {
    // view-prefixed session is NOT a meta-view — it could be a legitimate
    // orphan. Make sure we don't over-exclude.
    const panes: TmuxPane[] = [
      { id: "%104", target: "view-something:0.0", command: "claude", title: "not a view session" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies.length).toBe(1);
  });

  test("fleet session still protected (baseline sanity)", () => {
    const panes: TmuxPane[] = [
      { id: "%663", target: "101-mawjs:0.0", command: "claude", title: "mawjs lead" },
      { id: "%594", target: "112-fusion:0.0", command: "claude", title: "fusion" },
    ];
    const zombies = findZombiePanes(panes);
    expect(zombies).toEqual([]);
  });
});
