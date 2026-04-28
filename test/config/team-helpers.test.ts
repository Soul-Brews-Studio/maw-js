/**
 * Tests for src/commands/plugins/team/team-helpers.ts — loadTeam, writeShutdownRequest,
 * writeMessage, cleanupTeamDir using _setDirs for test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadTeam,
  writeShutdownRequest,
  writeMessage,
  cleanupTeamDir,
  _setDirs,
} from "../../src/commands/plugins/team/team-helpers";

describe("team-helpers", () => {
  let tmp: string;
  let teamsDir: string;
  let tasksDir: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-team-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    teamsDir = join(tmp, "teams");
    tasksDir = join(tmp, "tasks");
    mkdirSync(teamsDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
    _setDirs(teamsDir, tasksDir);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("loadTeam", () => {
    it("returns null for non-existent team", () => {
      expect(loadTeam("ghost")).toBeNull();
    });

    it("loads team config from file", () => {
      const teamDir = join(teamsDir, "alpha");
      mkdirSync(teamDir, { recursive: true });
      const config = { name: "alpha", members: [{ name: "spark" }] };
      writeFileSync(join(teamDir, "config.json"), JSON.stringify(config));
      const result = loadTeam("alpha");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("alpha");
      expect(result!.members).toHaveLength(1);
    });

    it("returns null for invalid JSON", () => {
      const teamDir = join(teamsDir, "broken");
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(join(teamDir, "config.json"), "not json");
      expect(loadTeam("broken")).toBeNull();
    });

    it("preserves member details", () => {
      const teamDir = join(teamsDir, "beta");
      mkdirSync(teamDir, { recursive: true });
      const config = {
        name: "beta",
        members: [{ name: "forge", color: "red", model: "opus" }],
      };
      writeFileSync(join(teamDir, "config.json"), JSON.stringify(config));
      const result = loadTeam("beta");
      expect(result!.members[0].color).toBe("red");
      expect(result!.members[0].model).toBe("opus");
    });
  });

  describe("writeShutdownRequest", () => {
    it("creates inbox file with shutdown message", () => {
      const teamDir = join(teamsDir, "alpha", "inboxes");
      mkdirSync(teamDir, { recursive: true });
      writeShutdownRequest("alpha", "spark", "session ending");
      const inboxFile = join(teamDir, "spark.json");
      expect(existsSync(inboxFile)).toBe(true);
      const messages = JSON.parse(readFileSync(inboxFile, "utf8"));
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe("maw-team-shutdown");
    });

    it("includes shutdown reason in message text", () => {
      const teamDir = join(teamsDir, "alpha", "inboxes");
      mkdirSync(teamDir, { recursive: true });
      writeShutdownRequest("alpha", "spark", "context limit");
      const messages = JSON.parse(readFileSync(join(teamDir, "spark.json"), "utf8"));
      const payload = JSON.parse(messages[0].text);
      expect(payload.type).toBe("shutdown_request");
      expect(payload.reason).toBe("context limit");
    });

    it("appends to existing messages", () => {
      const teamDir = join(teamsDir, "alpha", "inboxes");
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(join(teamDir, "spark.json"), JSON.stringify([{ existing: true }]));
      writeShutdownRequest("alpha", "spark", "test");
      const messages = JSON.parse(readFileSync(join(teamDir, "spark.json"), "utf8"));
      expect(messages).toHaveLength(2);
    });

    it("includes timestamp", () => {
      const teamDir = join(teamsDir, "alpha", "inboxes");
      mkdirSync(teamDir, { recursive: true });
      writeShutdownRequest("alpha", "spark", "test");
      const messages = JSON.parse(readFileSync(join(teamDir, "spark.json"), "utf8"));
      expect(messages[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("marks message as unread", () => {
      const teamDir = join(teamsDir, "alpha", "inboxes");
      mkdirSync(teamDir, { recursive: true });
      writeShutdownRequest("alpha", "spark", "test");
      const messages = JSON.parse(readFileSync(join(teamDir, "spark.json"), "utf8"));
      expect(messages[0].read).toBe(false);
    });
  });

  describe("writeMessage", () => {
    it("creates inbox directory and file", () => {
      writeMessage("beta", "forge", "boom", "hello forge");
      const inboxFile = join(teamsDir, "beta", "inboxes", "forge.json");
      expect(existsSync(inboxFile)).toBe(true);
    });

    it("includes message content", () => {
      writeMessage("beta", "forge", "boom", "build the API");
      const messages = JSON.parse(readFileSync(join(teamsDir, "beta", "inboxes", "forge.json"), "utf8"));
      const payload = JSON.parse(messages[0].text);
      expect(payload.type).toBe("message");
      expect(payload.content).toBe("build the API");
    });

    it("includes from field", () => {
      writeMessage("beta", "forge", "spark", "review needed");
      const messages = JSON.parse(readFileSync(join(teamsDir, "beta", "inboxes", "forge.json"), "utf8"));
      expect(messages[0].from).toBe("spark");
    });

    it("truncates summary to 80 chars", () => {
      const longText = "A".repeat(100);
      writeMessage("beta", "forge", "boom", longText);
      const messages = JSON.parse(readFileSync(join(teamsDir, "beta", "inboxes", "forge.json"), "utf8"));
      expect(messages[0].summary.length).toBe(80);
    });

    it("appends to existing messages", () => {
      writeMessage("beta", "forge", "boom", "first");
      writeMessage("beta", "forge", "spark", "second");
      const messages = JSON.parse(readFileSync(join(teamsDir, "beta", "inboxes", "forge.json"), "utf8"));
      expect(messages).toHaveLength(2);
    });
  });

  describe("cleanupTeamDir", () => {
    it("removes team directory", () => {
      const teamDir = join(teamsDir, "cleanup-test");
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(join(teamDir, "config.json"), "{}");
      cleanupTeamDir("cleanup-test");
      expect(existsSync(teamDir)).toBe(false);
    });

    it("removes tasks directory", () => {
      const taskDir = join(tasksDir, "cleanup-test");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "task.json"), "{}");
      cleanupTeamDir("cleanup-test");
      expect(existsSync(taskDir)).toBe(false);
    });

    it("handles non-existent directories gracefully", () => {
      expect(() => cleanupTeamDir("nonexistent")).not.toThrow();
    });

    it("removes both team and tasks dirs", () => {
      const teamDir = join(teamsDir, "both");
      const taskDir = join(tasksDir, "both");
      mkdirSync(teamDir, { recursive: true });
      mkdirSync(taskDir, { recursive: true });
      cleanupTeamDir("both");
      expect(existsSync(teamDir)).toBe(false);
      expect(existsSync(taskDir)).toBe(false);
    });
  });
});
