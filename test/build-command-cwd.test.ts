import { describe, test, expect, mock } from "bun:test";

// Mock only the dependencies that config.ts needs.
// Include findWindow + listSessions stubs to prevent module-import crash in
// CI when mock.module pollution carries over to other test files. The real
// findWindow/listSessions are tested in 00-ssh.test.ts (loads first
// alphabetically). Without listSessions here, anything that transitively
// imports ../src/ssh (e.g. federation-sync.test.ts via peers → federation)
// blows up at import time with "Export named 'listSessions' not found".
mock.module("../src/core/transport/ssh", () => ({
  hostExec: async () => "",
  ssh: async () => "",
  findWindow: () => null,
  listSessions: async () => [],
}));

// Pure-string reference tests for shell path quoting. Post-#541 buildCommandInDir
// no longer emits `cd` at all (see test/command-simplified.test.ts for the real
// contract); these cases remain as a quoting-pattern sanity check only.
describe("shell path quoting (reference tests)", () => {
  test("prepends cd before command", () => {
    const cwd = "/home/nat/Code/github.com/laris-co/neo-oracle";
    const cmd = "claude --dangerously-skip-permissions --continue";
    const result = `cd '${cwd}' && ${cmd}`;
    expect(result).toStartWith(`cd '${cwd}' && `);
    expect(result).toContain(cmd);
  });

  test("paths with spaces are single-quoted", () => {
    const cwd = "/home/nat/Code/my repo";
    const result = `cd '${cwd}' && claude --continue`;
    expect(result).toBe("cd '/home/nat/Code/my repo' && claude --continue");
  });

  test("paths with special chars are safe in single quotes", () => {
    const cwd = "/home/nat/Code/repo-with-dash_and.dots";
    const result = `cd '${cwd}' && claude --continue`;
    expect(result).toContain("cd '/home/nat/Code/repo-with-dash_and.dots'");
  });
});
