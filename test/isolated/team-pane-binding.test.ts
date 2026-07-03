import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveTeamMemberPane } from "../../src/commands/shared/team-member-pane";
import { bindMemberPaneId } from "../../src/vendor/mpr-plugins/team/team-lifecycle";
import { _setDirs } from "../../src/vendor/mpr-plugins/team/team-helpers";

// kobo-81 — maw-team pane binding + addressing. A worker spawned by
// `maw team spawn --exec` must bind its %pane-id into the roster so
// `maw hey <role>` / `maw team send` reach the real pane.

let dir: string;
function writeTeam(team: string, members: any[]) {
  mkdirSync(join(dir, team), { recursive: true });
  writeFileSync(join(dir, team, "config.json"), JSON.stringify({ name: team, members }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kobo81-teams-"));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("resolveTeamMemberPane (kobo-81 hey/send addressing)", () => {
  test("resolves a live member's bound pane id by name", () => {
    writeTeam("crew", [{ name: "worker-3", tmuxPaneId: "%603" }]);
    expect(resolveTeamMemberPane("worker-3", { teamsDir: dir })).toBe("%603");
  });

  test("resolves by agentId too", () => {
    writeTeam("crew", [{ name: "worker-3", agentId: "worker-3@crew", tmuxPaneId: "%603" }]);
    expect(resolveTeamMemberPane("worker-3@crew", { teamsDir: dir })).toBe("%603");
  });

  test("returns null for an unbound member (no/sentinel pane) — no false hit", () => {
    writeTeam("crew", [
      { name: "lead", tmuxPaneId: "" },
      { name: "ghost", tmuxPaneId: "in-process" },
      { name: "nopane" },
    ]);
    expect(resolveTeamMemberPane("lead", { teamsDir: dir })).toBeNull();
    expect(resolveTeamMemberPane("ghost", { teamsDir: dir })).toBeNull();
    expect(resolveTeamMemberPane("nopane", { teamsDir: dir })).toBeNull();
  });

  test("returns null for an unknown name / missing teams dir", () => {
    writeTeam("crew", [{ name: "worker-3", tmuxPaneId: "%603" }]);
    expect(resolveTeamMemberPane("nobody", { teamsDir: dir })).toBeNull();
    expect(resolveTeamMemberPane("worker-3", { teamsDir: join(dir, "nope") })).toBeNull();
  });

  test("livePanes stale-guard skips a binding whose pane is gone", () => {
    writeTeam("crew", [{ name: "worker-3", tmuxPaneId: "%603" }]);
    expect(resolveTeamMemberPane("worker-3", { teamsDir: dir, livePanes: new Set(["%1"]) })).toBeNull();
    expect(resolveTeamMemberPane("worker-3", { teamsDir: dir, livePanes: new Set(["%603"]) })).toBe("%603");
  });

  test("scans across multiple teams", () => {
    writeTeam("crew", [{ name: "worker-1", tmuxPaneId: "%1" }]);
    writeTeam("warroom", [{ name: "coord", tmuxPaneId: "%2" }]);
    expect(resolveTeamMemberPane("coord", { teamsDir: dir })).toBe("%2");
  });
});

describe("bindMemberPaneId (kobo-81 spawn --exec binding)", () => {
  test("writes tmuxPaneId + agentId onto the member; re-bind overwrites (survives respawn)", () => {
    _setDirs(dir, join(dir, "tasks"));
    writeTeam("crew", [{ name: "worker-3" }]);
    bindMemberPaneId("crew", "worker-3", "%603");
    let cfg = JSON.parse(readFileSync(join(dir, "crew", "config.json"), "utf-8"));
    expect(cfg.members[0].tmuxPaneId).toBe("%603");
    expect(cfg.members[0].agentId).toBe("worker-3@crew");
    // reincarnation: a new life gets a new pane → binding updates in place
    bindMemberPaneId("crew", "worker-3", "%777");
    cfg = JSON.parse(readFileSync(join(dir, "crew", "config.json"), "utf-8"));
    expect(cfg.members[0].tmuxPaneId).toBe("%777");
  });

  test("no-op (no throw) when team/member absent", () => {
    _setDirs(dir, join(dir, "tasks"));
    writeTeam("crew", [{ name: "worker-3" }]);
    expect(() => bindMemberPaneId("crew", "nobody", "%1")).not.toThrow();
    expect(() => bindMemberPaneId("noteam", "worker-3", "%1")).not.toThrow();
  });
});
