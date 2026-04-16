import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

// Regression for #372: resolveOraclePath defensive against -oracle suffix.
//
// Bug: maw bud passes parentName="neo-oracle" (with suffix) to cmdSoulSync.
// resolveOraclePath did `grep -i '/${name}-oracle$'` → looking for
// '/neo-oracle-oracle$' which doesn't match. Soul-sync silently failed.
//
// Fix: strip trailing -oracle before re-appending so callers passing either
// "neo" or "neo-oracle" both land on the same lookup.

let commands: string[] = [];
const mockExec = async (cmd: string, _host?: string) => {
  commands.push(cmd);
  // Return a fake ghq path for any "/<stem>-oracle$" grep
  if (cmd.includes("ghq list") && cmd.includes("/neo-oracle$")) {
    return "/home/test/Code/github.com/laris-co/neo-oracle\n";
  }
  return "";
};

mock.module("../../src/config", () =>
  mockConfigModule(() => ({ host: "local" })),
);
mock.module("../../src/core/transport/ssh", () => ({
  hostExec: mockExec,
  ssh: mockExec,
  findWindow: () => null,
  listSessions: async () => [],
  capture: async () => "",
  sendKeys: async () => {},
  selectWindow: async () => {},
  switchClient: async () => {},
  getPaneCommand: async () => "",
  getPaneCommands: async () => ({}),
  getPaneInfos: async () => ({}),
}));

const { resolveOraclePath } = await import("../../src/commands/plugins/soul-sync/impl");

beforeEach(() => {
  commands = [];
});

describe("resolveOraclePath defensive suffix handling (#372)", () => {
  test("bare name 'neo' resolves to neo-oracle path", async () => {
    const path = await resolveOraclePath("neo");
    expect(path).toBe("/home/test/Code/github.com/laris-co/neo-oracle");
    expect(commands[0]).toContain("/neo-oracle$");
  });

  test("full name 'neo-oracle' ALSO resolves (was broken pre-#372)", async () => {
    const path = await resolveOraclePath("neo-oracle");
    expect(path).toBe("/home/test/Code/github.com/laris-co/neo-oracle");
    // Critical: must grep for /neo-oracle$ NOT /neo-oracle-oracle$
    expect(commands[0]).toContain("/neo-oracle$");
    expect(commands[0]).not.toContain("/neo-oracle-oracle$");
  });

  test("both forms produce IDENTICAL grep command", async () => {
    await resolveOraclePath("neo");
    const bareCmd = commands[0];
    commands = [];
    await resolveOraclePath("neo-oracle");
    const fullCmd = commands[0];
    expect(bareCmd).toBe(fullCmd);
  });

  test("non-existent oracle returns null in both forms", async () => {
    expect(await resolveOraclePath("doesnotexist")).toBe(null);
    expect(await resolveOraclePath("doesnotexist-oracle")).toBe(null);
  });
});
