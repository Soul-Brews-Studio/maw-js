import { describe, expect, it, mock } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const wtPath = "/ghq/github.com/kxlahsimx09/mb-next-payment-gateway.wt-1-codex";
let commands: string[] = [];

mock.module(join(root, "core/transport/ssh"), () => ({
  hostExec: async (cmd: string) => {
    commands.push(cmd);
    if (cmd.startsWith("tmux list-panes")) {
      return [
        "fleet|||1|||next-writer-codex|||0|||codex|||" + wtPath,
      ].join("\n");
    }
    if (cmd.includes("worktree remove")) {
      throw new Error("worktree remove should not run for active panes");
    }
    return "";
  },
  listSessions: async () => [
    { name: "fleet", windows: [{ name: "next-writer-codex", index: 1, active: true }] },
  ],
}));

mock.module(join(root, "core/transport/tmux"), () => ({
  tmux: { killWindow: async () => {} },
}));

mock.module(join(root, "config/ghq-root"), () => ({
  getGhqRoot: () => "/ghq",
}));

mock.module(join(root, "commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => [],
}));

const { cleanupWorktree } = await import("./worktrees-cleanup");

describe("cleanupWorktree active-pane guard", () => {
  it("refuses to remove a worktree while a live pane cwd is inside it", async () => {
    commands = [];

    const log = await cleanupWorktree(wtPath);

    expect(log.join("\n")).toContain("refusing to remove active worktree");
    expect(log.join("\n")).toContain("fleet:1.0 codex");
    expect(commands.some(cmd => cmd.includes("worktree remove"))).toBe(false);
  });
});
