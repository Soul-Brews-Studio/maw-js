import { describe, expect, test } from "bun:test";
import { cmdDone, type DoneDeps } from "../../src/commands/shared/done";

function deps() {
  const logs: string[] = [];
  const errors: string[] = [];
  const commands: string[] = [];
  const snapshots: string[] = [];
  const d: DoneDeps = {
    listSessions: async () => [{ name: "work", windows: [{ index: 0, name: "lead", active: true }] }],
    ghqRoot: "/repos",
    fleetDir: "/fleet",
    fleetDirs: ["/fleet"],
    fs: {
      readdirSync: () => [],
      readFileSync: () => { throw new Error("no file"); },
      writeFileSync: () => {},
      mkdirSync: () => {},
      appendFileSync: () => {},
    },
    hostExec: async (command) => {
      commands.push(command);
      if (command.startsWith("find ")) return "";
      throw new Error(`unexpected command: ${command}`);
    },
    tmux: {
      killWindow: async () => { throw new Error("should not kill"); },
      sendText: async () => { throw new Error("should not send"); },
    },
    takeSnapshot: async (trigger) => { snapshots.push(trigger); },
    logger: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    },
  };
  return { d, logs, errors, commands, snapshots };
}

describe("done missing target safety", () => {
  test("fails non-zero semantics for missing windows with no worktree match", async () => {
    const h = deps();

    await expect(cmdDone("missing-window", { dryRun: true }, h.d))
      .rejects.toThrow("no done target matched 'missing-window'");

    expect(h.logs.join("\n")).toContain("window 'missing-window' not running");
    expect(h.logs.join("\n")).toContain("no worktree to remove");
    expect(h.errors.join("\n")).toContain("no done target matched 'missing-window'");
    expect(h.snapshots).toEqual([]);
  });

  test("adds a --all hint only after confirming literal all was not a target", async () => {
    const h = deps();

    await expect(cmdDone("all", { force: true }, h.d))
      .rejects.toThrow("did you mean `maw done --all`");

    expect(h.commands).toEqual(["find '/repos/github.com' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null"]);
    expect(h.snapshots).toEqual([]);
  });
});
