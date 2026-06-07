import { beforeEach, describe, expect, mock, test } from "bun:test";

const wakeResolvePath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts");
const wakeCallPath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts");
const profileImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/profile/impl.ts");

let peer: { url: string; node?: string | null } | null = null;
let peerResult: { ok: boolean; status?: number; data?: any } = { ok: false, data: {} };
const peerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];
let paneRaw = "";
const hostExecCalls: string[] = [];
let profileShowThrows = false;

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    console.log(`wake ${oracle}`);
  },
}));
mock.module("maw-js/commands/shared/fleet", () => ({ cmdWakeAll: async () => console.log("wake all") }));
mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => undefined,
}));
mock.module("maw-js/commands/shared/wake-resolve", () => ({
  fetchGitHubPrompt: async (kind: string, num: number) => `${kind}-${num}`,
}));
mock.module(wakeResolvePath, () => ({ resolvePeer: () => peer }));
mock.module(wakeCallPath, () => ({
  callPeerWake: async (url: string, body: Record<string, unknown>) => {
    peerCalls.push({ url, body });
    return peerResult;
  },
}));

mock.module(profileImplPath, () => ({
  cmdList: () => [],
  cmdCurrent: () => "all",
  formatList: () => "profiles",
  cmdUse: (name: string) => ({ name }),
  cmdShow: (name: string) => {
    if (profileShowThrows) throw new Error(`profile parse failed: ${name}`);
    return { name };
  },
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [],
  tmuxCmd: () => "tmux",
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (command.includes("list-panes -a -F")) return paneRaw;
    throw new Error(`unexpected hostExec: ${command}`);
  },
}));

const { default: wakeHandler } = await import("../../src/vendor/mpr-plugins/wake/index.ts?coverage-100-vendor-a-wake");
const { default: profileHandler } = await import("../../src/vendor/mpr-plugins/profile/index.ts?coverage-100-vendor-a-profile");
const { cmdKill } = await import("../../src/vendor/mpr-plugins/kill/impl.ts?coverage-100-vendor-a-kill");

beforeEach(() => {
  peer = null;
  peerResult = { ok: false, data: {} };
  peerCalls.length = 0;
  wakeCalls.length = 0;
  paneRaw = "";
  hostExecCalls.length = 0;
  profileShowThrows = false;
});

describe("coverage-100 vendor-a wake/profile/kill gaps", () => {
  test("wake peer failure with no status reports no response and API pr maps snapshot flags", async () => {
    peer = { url: "http://peer:3456", node: "peer" };
    const failed = await wakeHandler({ source: "cli", args: ["neo", "--peer", "peer"] } as any);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("no response");
    expect(peerCalls).toEqual([{ url: "http://peer:3456", body: { oracle: "neo" } }]);

    const api = await wakeHandler({ source: "api", args: { oracle: "api", pr: 12, repo: "org/repo", wt: "slot", name: "named", dryRun: true, noRehydrate: true, snapshot: "snap-1" } } as any);
    expect(api.ok).toBe(true);
    expect(wakeCalls.at(-1)).toEqual({
      oracle: "api",
      opts: { wt: "slot", prompt: "pr-12", task: "pr-12", name: "named", dryRun: true, noRehydrate: true, snapshotId: "snap-1", fromSnapshot: true },
    });
  });

  test("profile show catches implementation exceptions and restores console", async () => {
    const originalLog = console.log;
    profileShowThrows = true;
    const result = await profileHandler({ source: "cli", args: ["show", "broken"] } as any);
    expect(result).toEqual({ ok: false, error: "profile parse failed: broken", output: "" });
    expect(console.log).toBe(originalLog);
  });

  test("kill reports ambiguous pane aliases when no session matches", async () => {
    paneRaw = [
      "%101|||alpha:0.0|||codex|||worker|||/tmp/alpha.wt-1-codex",
      "%102|||beta:0.0|||codex|||worker|||/tmp/beta.wt-2-codex",
    ].join("\n");

    await expect(cmdKill("codex")).rejects.toThrow("'codex' is ambiguous");
    expect(hostExecCalls).toEqual(["tmux list-panes -a -F '#{pane_id}|||#{session_name}:#{window_index}.#{pane_index}|||#{pane_title}|||#{@maw_tile_role}|||#{pane_current_path}'"]);
  });
});
