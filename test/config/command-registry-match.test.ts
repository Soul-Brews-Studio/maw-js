/**
 * Tests for src/cli/command-registry-match.ts — registerCommand, matchCommand, listCommands.
 * Uses the global commands Map — cleans up after each test.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { registerCommand, matchCommand, listCommands } from "../../src/cli/command-registry-match";
import { commands } from "../../src/cli/command-registry-types";

describe("command-registry-match", () => {
  beforeEach(() => {
    commands.clear();
  });

  describe("registerCommand", () => {
    it("registers a simple command", () => {
      registerCommand({ name: "peek", description: "Peek at agents" }, "/peek.ts", "builtin");
      expect(commands.has("peek")).toBe(true);
    });

    it("registers array of aliases", () => {
      registerCommand({ name: ["ps", "list", "ls"], description: "List" }, "/ps.ts", "builtin");
      expect(commands.has("ps")).toBe(true);
      expect(commands.has("list")).toBe(true);
      expect(commands.has("ls")).toBe(true);
    });

    it("normalizes name to lowercase", () => {
      registerCommand({ name: "Peek", description: "Peek" }, "/p.ts", "builtin");
      expect(commands.has("peek")).toBe(true);
    });

    it("overrides existing command", () => {
      registerCommand({ name: "peek", description: "Old" }, "/old.ts", "builtin");
      registerCommand({ name: "peek", description: "New" }, "/new.ts", "user");
      expect(commands.get("peek")!.desc.description).toBe("New");
    });
  });

  describe("matchCommand", () => {
    it("matches single-word command", () => {
      registerCommand({ name: "peek", description: "Peek" }, "/p.ts", "builtin");
      const result = matchCommand(["peek"]);
      expect(result).not.toBeNull();
      expect(result!.key).toBe("peek");
      expect(result!.remaining).toEqual([]);
    });

    it("passes remaining args", () => {
      registerCommand({ name: "peek", description: "Peek" }, "/p.ts", "builtin");
      const result = matchCommand(["peek", "neo", "--verbose"]);
      expect(result!.remaining).toEqual(["neo", "--verbose"]);
    });

    it("matches multi-word command (longest prefix)", () => {
      registerCommand({ name: "fleet", description: "Fleet" }, "/f.ts", "builtin");
      registerCommand({ name: "fleet doctor", description: "Doctor" }, "/fd.ts", "builtin");
      const result = matchCommand(["fleet", "doctor", "--fix"]);
      expect(result!.key).toBe("fleet doctor");
      expect(result!.remaining).toEqual(["--fix"]);
    });

    it("returns null for no match", () => {
      expect(matchCommand(["nonexistent"])).toBeNull();
    });

    it("returns null for empty args", () => {
      expect(matchCommand([])).toBeNull();
    });

    it("case-insensitive matching", () => {
      registerCommand({ name: "peek", description: "Peek" }, "/p.ts", "builtin");
      const result = matchCommand(["PEEK"]);
      expect(result).not.toBeNull();
    });

    it("prefers longer match over shorter", () => {
      registerCommand({ name: "plugin", description: "Plugin" }, "/p.ts", "builtin");
      registerCommand({ name: "plugin install", description: "Install" }, "/pi.ts", "builtin");
      const result = matchCommand(["plugin", "install", "hello"]);
      expect(result!.key).toBe("plugin install");
    });
  });

  describe("listCommands", () => {
    it("returns empty for no commands", () => {
      expect(listCommands()).toEqual([]);
    });

    it("lists registered commands", () => {
      registerCommand({ name: "peek", description: "Peek" }, "/p.ts", "builtin");
      registerCommand({ name: "send", description: "Send" }, "/s.ts", "builtin");
      const list = listCommands();
      expect(list).toHaveLength(2);
    });

    it("deduplicates by path", () => {
      registerCommand({ name: ["ps", "ls"], description: "List" }, "/same.ts", "builtin");
      const list = listCommands();
      expect(list).toHaveLength(1);
    });
  });
});
