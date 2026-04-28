/**
 * Tests for src/config/command.ts — buildCommand, buildCommandInDir, getEnvVars.
 *
 * Isolated because we use mock.module to control loadConfig output.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { MawConfig } from "../../src/config/types";

const defaultConfig: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/home/user/Code",
  oracleUrl: "http://localhost:47779",
  env: { ANTHROPIC_API_KEY: "sk-test-123" },
  commands: { default: "claude --dangerously-skip-permissions --continue" },
  sessions: {},
};

let mockConfig = { ...defaultConfig };

mock.module("../../src/config/load", () => ({
  loadConfig: () => mockConfig,
}));

// Import after mock
const { buildCommand, buildCommandInDir, getEnvVars } = await import("../../src/config/command");

beforeEach(() => {
  mockConfig = { ...defaultConfig, commands: { ...defaultConfig.commands }, env: { ...defaultConfig.env } };
});

describe("buildCommand", () => {
  test("returns default command for unmatched agent", () => {
    const cmd = buildCommand("random-agent");
    expect(cmd).toContain("claude");
  });

  test("matches exact agent name", () => {
    mockConfig.commands = { default: "claude", neo: "claude --resume abc" };
    const cmd = buildCommand("neo");
    expect(cmd).toContain("--resume abc");
  });

  test("matches prefix glob pattern", () => {
    mockConfig.commands = { default: "claude", "neo-*": "claude --profile neo" };
    const cmd = buildCommand("neo-oracle");
    expect(cmd).toContain("--profile neo");
  });

  test("matches suffix glob pattern", () => {
    mockConfig.commands = { default: "claude", "*-oracle": "claude --profile oracle" };
    const cmd = buildCommand("neo-oracle");
    expect(cmd).toContain("--profile oracle");
  });

  test("falls back to default when no pattern matches", () => {
    mockConfig.commands = { default: "claude", "neo-*": "special" };
    const cmd = buildCommand("homekeeper");
    expect(cmd).toContain("claude");
    expect(cmd).not.toContain("special");
  });

  test("injects --resume when sessionIds configured", () => {
    mockConfig.commands = { default: "claude --continue" };
    (mockConfig as any).sessionIds = { neo: "uuid-123" };
    const cmd = buildCommand("neo");
    expect(cmd).toContain('--resume "uuid-123"');
    expect(cmd).not.toContain("--continue");
  });

  test("adds --resume without replacing when no --continue", () => {
    mockConfig.commands = { default: "claude" };
    (mockConfig as any).sessionIds = { neo: "uuid-456" };
    const cmd = buildCommand("neo");
    expect(cmd).toContain('--resume "uuid-456"');
  });

  test("sessionId glob matching works", () => {
    mockConfig.commands = { default: "claude --continue" };
    (mockConfig as any).sessionIds = { "neo-*": "glob-uuid" };
    const cmd = buildCommand("neo-oracle");
    expect(cmd).toContain('--resume "glob-uuid"');
  });

  test("generates fallback for --continue command", () => {
    mockConfig.commands = { default: "claude --continue" };
    const cmd = buildCommand("agent");
    // Should have "cmd || fallback" pattern
    expect(cmd).toContain(" || ");
  });

  test("generates fallback for --resume command", () => {
    mockConfig.commands = { default: "claude" };
    (mockConfig as any).sessionIds = { agent: "uuid-789" };
    const cmd = buildCommand("agent");
    expect(cmd).toContain(" || ");
    // Fallback should have --session-id instead of --resume
    const parts = cmd.split(" || ");
    expect(parts[0]).toContain("--resume");
    expect(parts[1]).toContain("--session-id");
  });

  test("no fallback when no --continue or --resume", () => {
    mockConfig.commands = { default: "claude --dangerously-skip-permissions" };
    const cmd = buildCommand("agent");
    expect(cmd).not.toContain(" || ");
  });

  test("uses 'claude' when default command is empty", () => {
    mockConfig.commands = { default: "" };
    const cmd = buildCommand("agent");
    expect(cmd).toBe("claude");
  });
});

describe("buildCommandInDir", () => {
  test("returns same as buildCommand (cwd param is no-op post #541)", () => {
    const direct = buildCommand("neo");
    const withDir = buildCommandInDir("neo", "/some/path");
    expect(withDir).toBe(direct);
  });

  test("does not include cd prefix", () => {
    const cmd = buildCommandInDir("neo", "/some/path with spaces");
    expect(cmd).not.toContain("cd ");
  });
});

describe("getEnvVars", () => {
  test("returns env from config", () => {
    const env = getEnvVars();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-123");
  });

  test("returns empty object when env is empty", () => {
    mockConfig.env = {};
    const env = getEnvVars();
    expect(env).toEqual({});
  });
});
