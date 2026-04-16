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
  // Post-alpha.58: ghqFind helper does grep in JS, sends "ghq list --full-path"
  // (no inline grep). Return a realistic ghq output and let the helper filter.
  if (cmd.includes("ghq list")) {
    return [
      "/home/test/Code/github.com/laris-co/neo-oracle",
      "/home/test/Code/github.com/Soul-Brews-Studio/maw-js",
      "/home/test/Code/github.com/laris-co/some-other-repo",
    ].join("\n") + "\n";
  }
  return "";
};

mock.module("../../src/config", () =>
  mockConfigModule(() => ({ host: "local" })),
);
import { mockSshModule } from "../helpers/mock-ssh";
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: mockExec,
  ssh: mockExec,
}));

const { resolveOraclePath } = await import("../../src/commands/plugins/soul-sync/impl");

beforeEach(() => {
  commands = [];
});

describe("resolveOraclePath defensive suffix handling (#372)", () => {
  test("bare name 'neo' resolves to neo-oracle path", async () => {
    const path = await resolveOraclePath("neo");
    expect(path).toBe("/home/test/Code/github.com/laris-co/neo-oracle");
  });

  test("full name 'neo-oracle' ALSO resolves (was broken pre-#372)", async () => {
    const path = await resolveOraclePath("neo-oracle");
    expect(path).toBe("/home/test/Code/github.com/laris-co/neo-oracle");
    // Critical: must NOT look up /neo-oracle-oracle (the old double-suffix bug)
    // — verified indirectly: the result is the SAME as the bare form below.
  });

  test("both forms produce identical lookup behavior", async () => {
    const bare = await resolveOraclePath("neo");
    const full = await resolveOraclePath("neo-oracle");
    expect(bare).toBe(full);
  });

  test("non-existent oracle returns null in both forms", async () => {
    expect(await resolveOraclePath("doesnotexist")).toBe(null);
    expect(await resolveOraclePath("doesnotexist-oracle")).toBe(null);
  });
});
