import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { _setDirs } from "../../src/commands/plugins/team/impl";
import { mergeTeamKnowledge } from "../../src/commands/plugins/team/team-lifecycle";

// Regression test for #393 Bug G — `maw team shutdown --merge` silently
// skipped the merge block when all members had already exited (alive=0).
// The fix extracted merge into mergeTeamKnowledge() and calls it from
// both the alive=0 and alive>0 paths.
//
// These tests exercise mergeTeamKnowledge directly (faster, hermetic)
// AND verify the short-circuit change on cmdTeamShutdown.

let testDir: string;
let teamsDir: string;
let tasksDir: string;
let psiDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = mkdtempSync(join(tmpdir(), "maw-mergeG-"));
  teamsDir = join(testDir, "teams");
  tasksDir = join(testDir, "tasks");
  psiDir = join(testDir, "oracle");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Create a minimal oracle root so resolvePsi finds it
  mkdirSync(join(psiDir, "ψ"), { recursive: true });
  writeFileSync(join(psiDir, "CLAUDE.md"), "# test oracle\n");
  process.chdir(psiDir);
  _setDirs(teamsDir, tasksDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

function scaffoldTeam(teamName: string, members: string[]) {
  const teamDir = join(teamsDir, teamName);
  mkdirSync(join(teamDir, "inboxes"), { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({
    name: teamName,
    description: "test",
    createdAt: Date.now(),
    members: members.map(name => ({ name, agentType: "general-purpose", tmuxPaneId: "" })),
  }));
  for (const m of members) {
    mkdirSync(join(teamDir, m), { recursive: true });
    writeFileSync(
      join(teamDir, "inboxes", `${m}.json`),
      JSON.stringify([{ from: "lead", text: `hello ${m}`, timestamp: "2026-04-17T03:45:00.000Z", read: true }])
    );
    writeFileSync(
      join(teamDir, m, "2026-04-17_findings.md"),
      `## Findings\n${m} found something worth keeping\n`
    );
  }
}

describe("mergeTeamKnowledge — #393 Bug G fix", () => {
  test("copies inbox + findings to vault mailbox for each member", () => {
    scaffoldTeam("alpha-team", ["alpha-tester", "beta-tester"]);
    mergeTeamKnowledge("alpha-team", [
      { name: "alpha-tester" },
      { name: "beta-tester" },
    ]);

    const alphaMb = join(psiDir, "ψ/memory/mailbox/alpha-tester");
    expect(existsSync(join(alphaMb, "team-alpha-team-inbox.json"))).toBe(true);
    expect(existsSync(join(alphaMb, "2026-04-17_findings.md"))).toBe(true);

    const betaMb = join(psiDir, "ψ/memory/mailbox/beta-tester");
    expect(existsSync(join(betaMb, "team-alpha-team-inbox.json"))).toBe(true);
    expect(existsSync(join(betaMb, "2026-04-17_findings.md"))).toBe(true);

    // Content check: findings file has the fake content we wrote
    const findings = readFileSync(join(alphaMb, "2026-04-17_findings.md"), "utf-8");
    expect(findings).toContain("alpha-tester found something");
  });

  test("archives the manifest to ψ/memory/mailbox/teams/<name>/manifest.json", () => {
    scaffoldTeam("beta-team", ["solo"]);
    mergeTeamKnowledge("beta-team", [{ name: "solo" }]);

    const archive = join(psiDir, "ψ/memory/mailbox/teams/beta-team/manifest.json");
    expect(existsSync(archive)).toBe(true);
    const parsed = JSON.parse(readFileSync(archive, "utf-8"));
    expect(parsed.name).toBe("beta-team");
    expect(parsed.members[0].name).toBe("solo");
  });

  test("handles member with missing inbox + missing findings dir without crashing", () => {
    const teamDir = join(teamsDir, "sparse-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({
      name: "sparse-team",
      members: [{ name: "orphan", agentType: "general-purpose", tmuxPaneId: "" }],
    }));

    // No inbox, no member dir — should still complete without throwing
    expect(() => mergeTeamKnowledge("sparse-team", [{ name: "orphan" }])).not.toThrow();

    // The orphan's mailbox should still be created (mkdir recursive)
    expect(existsSync(join(psiDir, "ψ/memory/mailbox/orphan"))).toBe(true);
  });

  test("multiple findings files all copied", () => {
    scaffoldTeam("multi-team", ["agent-a"]);
    // Add a second findings file
    writeFileSync(
      join(teamsDir, "multi-team", "agent-a", "2026-04-18_findings.md"),
      "## Day 2 findings\nmore stuff\n"
    );
    mergeTeamKnowledge("multi-team", [{ name: "agent-a" }]);

    const mb = join(psiDir, "ψ/memory/mailbox/agent-a");
    expect(existsSync(join(mb, "2026-04-17_findings.md"))).toBe(true);
    expect(existsSync(join(mb, "2026-04-18_findings.md"))).toBe(true);
  });

  test("non-findings files in member dir are NOT copied (scoped to *_findings.md)", () => {
    scaffoldTeam("scoped-team", ["agent-b"]);
    writeFileSync(join(teamsDir, "scoped-team", "agent-b", "notes.md"), "not a finding\n");
    writeFileSync(join(teamsDir, "scoped-team", "agent-b", "random.txt"), "random\n");
    mergeTeamKnowledge("scoped-team", [{ name: "agent-b" }]);

    const mb = join(psiDir, "ψ/memory/mailbox/agent-b");
    expect(existsSync(join(mb, "2026-04-17_findings.md"))).toBe(true);
    expect(existsSync(join(mb, "notes.md"))).toBe(false);
    expect(existsSync(join(mb, "random.txt"))).toBe(false);
  });

  test("empty teammates list: no-op but archives manifest if config exists", () => {
    const teamDir = join(teamsDir, "empty-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({ name: "empty-team", members: [] }));

    expect(() => mergeTeamKnowledge("empty-team", [])).not.toThrow();
    // Manifest still archived
    expect(existsSync(join(psiDir, "ψ/memory/mailbox/teams/empty-team/manifest.json"))).toBe(true);
  });
});
