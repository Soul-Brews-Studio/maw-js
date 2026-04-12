import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadTeam, writeShutdownRequest, _setDirs, cmdTeamList, cmdCleanupZombies } from "../src/commands/team";

let testDir: string;
let teamsDir: string;
let tasksDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `maw-team-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  teamsDir = join(testDir, "teams");
  tasksDir = join(testDir, "tasks");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  _setDirs(teamsDir, tasksDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function createTeam(name: string, members: any[]) {
  const teamDir = join(teamsDir, name);
  mkdirSync(join(teamDir, "inboxes"), { recursive: true });
  writeFileSync(join(teamDir, "config.json"), JSON.stringify({
    name,
    description: `test team ${name}`,
    members,
    createdAt: Date.now(),
  }));
}

describe("loadTeam", () => {
  test("returns null for non-existent team", () => {
    expect(loadTeam("no-such-team")).toBeNull();
  });

  test("loads team config", () => {
    createTeam("my-team", [
      { name: "team-lead", agentType: "team-lead", tmuxPaneId: "" },
      { name: "builder", agentType: "general-purpose", tmuxPaneId: "%99" },
    ]);
    const team = loadTeam("my-team");
    expect(team).not.toBeNull();
    expect(team!.name).toBe("my-team");
    expect(team!.members).toHaveLength(2);
    expect(team!.members[1].tmuxPaneId).toBe("%99");
  });

  test("returns null for invalid JSON", () => {
    const teamDir = join(teamsDir, "bad-json");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), "not json");
    expect(loadTeam("bad-json")).toBeNull();
  });
});

describe("writeShutdownRequest", () => {
  test("creates inbox file with shutdown message", () => {
    createTeam("shutdown-test", [
      { name: "team-lead", agentType: "team-lead" },
      { name: "worker", agentType: "general-purpose" },
    ]);

    writeShutdownRequest("shutdown-test", "worker", "test teardown");

    const inboxPath = join(teamsDir, "shutdown-test", "inboxes", "worker.json");
    expect(existsSync(inboxPath)).toBe(true);

    const messages = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("maw-team-shutdown");
    expect(messages[0].read).toBe(false);

    const text = JSON.parse(messages[0].text);
    expect(text.type).toBe("shutdown_request");
    expect(text.reason).toBe("test teardown");
    expect(text.request_id).toMatch(/^shutdown-\d+@worker$/);
  });

  test("appends to existing inbox messages", () => {
    createTeam("append-test", [{ name: "worker", agentType: "general-purpose" }]);
    const inboxPath = join(teamsDir, "append-test", "inboxes", "worker.json");

    // Pre-existing message
    writeFileSync(inboxPath, JSON.stringify([
      { from: "lead", text: "do stuff", timestamp: "2026-01-01T00:00:00Z", read: true },
    ]));

    writeShutdownRequest("append-test", "worker", "appending");

    const messages = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBe("lead");
    expect(messages[1].from).toBe("maw-team-shutdown");
  });
});

describe("cmdTeamList", () => {
  test("handles no teams gracefully", async () => {
    // Point to empty dir — should not throw
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    expect(logs.some(l => l.includes("No teams found"))).toBe(true);
  });

  test("lists teams with member counts", async () => {
    createTeam("test-team", [
      { name: "team-lead", agentType: "team-lead", tmuxPaneId: "" },
      { name: "builder", agentType: "general-purpose", tmuxPaneId: "%99" },
      { name: "reviewer", agentType: "general-purpose", tmuxPaneId: "%100" },
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    expect(logs.some(l => l.includes("test-team"))).toBe(true);
  });
});

describe("cmdCleanupZombies", () => {
  test("runs without error and produces output", async () => {
    // Note: on a machine with real claude panes, this may find "zombies"
    // because _setDirs points to an empty teams dir. That's fine — we just
    // verify it doesn't crash and produces some output.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await cmdCleanupZombies();
    } finally {
      console.log = origLog;
    }
    // Should produce at least one line of output (either "No zombie" or "Found N orphan")
    expect(logs.length).toBeGreaterThan(0);
  });

  test("does not kill panes without --yes", async () => {
    // Even if zombies are found, without { yes: true } it should only report
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await cmdCleanupZombies({ yes: false });
    } finally {
      console.log = origLog;
    }
    // Should NOT contain "killed" — only reporting mode
    expect(logs.some(l => l.includes("killed"))).toBe(false);
  });
});
