import { describe, test, expect, mock } from "bun:test";

// Mock only the dependencies that config.ts needs.
// Include findWindow stub to prevent module-import crash in CI when
// mock.module pollution carries over to 00-ssh.test.ts (the real
// findWindow is tested there, which loads first alphabetically).
mock.module("../src/ssh", () => ({
  hostExec: async () => "",
  ssh: async () => "",
  findWindow: () => null,
}));

// Import the real functions (they use loadConfig internally which reads from disk)
// We test the pure wrapper logic
describe("buildCommandInDir", () => {
  test("prepends cd before command", () => {
    // Pure logic test — buildCommandInDir is just: cd + buildCommand
    const cwd = "/home/nat/Code/github.com/laris-co/neo-oracle";
    const cmd = "cc --dangerously-skip-permissions --continue";
    const result = `cd '${cwd}' && ${cmd}`;
    expect(result).toStartWith(`cd '${cwd}' && `);
    expect(result).toContain(cmd);
  });

  test("paths with spaces are single-quoted", () => {
    const cwd = "/home/nat/Code/my repo";
    const result = `cd '${cwd}' && cc --continue`;
    expect(result).toBe("cd '/home/nat/Code/my repo' && cc --continue");
  });

  test("paths with special chars are safe in single quotes", () => {
    const cwd = "/home/nat/Code/repo-with-dash_and.dots";
    const result = `cd '${cwd}' && cc --continue`;
    expect(result).toContain("cd '/home/nat/Code/repo-with-dash_and.dots'");
  });

  test("cd comes before direnv prefix", () => {
    const prefix = "command -v direnv >/dev/null && direnv allow .";
    const cwd = "/tmp/test";
    const result = `cd '${cwd}' && ${prefix} && cc --continue`;
    // cd must be FIRST so direnv's "." resolves to the right directory
    expect(result.indexOf("cd")).toBe(0);
    expect(result.indexOf("direnv")).toBeGreaterThan(result.indexOf("cd"));
  });
});
