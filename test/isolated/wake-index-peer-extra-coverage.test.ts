import { beforeEach, describe, expect, mock, test } from "bun:test";

const peerResolvePath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts");
const peerCallPath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts");

const wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];
const fetchPromptCalls: Array<{ kind: string; num: number; repo?: string }> = [];
let peer: { url: string; node: string | null } | null = null;
let peerResult: { ok: boolean; status?: number; data?: any } = { ok: true, data: { output: "remote ok" } };
let peerThrow: Error | null = null;
const peerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let wakeThrow: Error | null = null;

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    console.log(`wake ${oracle}`);
    if (wakeThrow) throw wakeThrow;
  },
}));

mock.module("maw-js/commands/shared/fleet", () => ({
  cmdWakeAll: async () => console.log("wake all"),
}));

mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => undefined,
}));

mock.module("maw-js/commands/shared/wake-resolve", () => ({
  fetchGitHubPrompt: async (kind: string, num: number, repo?: string) => {
    fetchPromptCalls.push({ kind, num, repo });
    return `${kind}-${num}-prompt`;
  },
}));

mock.module(peerResolvePath, () => ({
  resolvePeer: () => peer,
}));

mock.module(peerCallPath, () => ({
  callPeerWake: async (url: string, body: Record<string, unknown>) => {
    peerCalls.push({ url, body });
    if (peerThrow) throw peerThrow;
    return peerResult;
  },
}));

const { default: handler } = await import("../../src/vendor/mpr-plugins/wake/index.ts?wake-index-peer-extra");

beforeEach(() => {
  wakeCalls.length = 0;
  fetchPromptCalls.length = 0;
  peer = null;
  peerResult = { ok: true, data: { output: "remote ok" } };
  peerThrow = null;
  peerCalls.length = 0;
  wakeThrow = null;
});

describe("wake plugin peer and option branches", () => {
  test("forwards CLI wake to a peer with translated options and remote output", async () => {
    peer = { url: "http://white:3456", node: "white" };
    const result = await handler({
      source: "cli",
      args: ["neo", "task-name", "--peer", "white", "--wt", "slot", "--task", "prompt", "--issue", "5", "--pr", "7", "--repo", "org/repo", "--fresh", "--pick", "--name", "named"],
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("forwarded wake → white");
    expect(result.output).toContain("remote ok");
    expect(peerCalls).toEqual([{
      url: "http://white:3456",
      body: {
        oracle: "neo",
        task: "task-name",
        wt: "slot",
        prompt: "prompt",
        issue: 5,
        pr: 7,
        repo: "org/repo",
        fresh: true,
        pick: true,
        name: "named",
      },
    }]);
  });

  test("reports unknown peers, thrown peer calls, 404 peers, and generic peer failures", async () => {
    let result = await handler({ source: "cli", args: ["neo", "--peer", "missing"] } as any);
    expect(result).toEqual({ ok: false, error: "unknown peer alias: missing (see: maw peers list)" });

    peer = { url: "http://peer", node: null };
    peerThrow = new Error("offline");
    result = await handler({ source: "cli", args: ["neo", "--peer", "peer"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("offline");

    peerThrow = null;
    peerResult = { ok: false, status: 404, data: {} };
    result = await handler({ source: "cli", args: ["neo", "--peer", "peer"] } as any);
    expect(result.error).toContain("does not support /api/wake");

    peerResult = { ok: false, status: 500, data: { error: "bad remote" } };
    result = await handler({ source: "cli", args: ["neo", "--peer", "peer"] } as any);
    expect(result.error).toContain("bad remote");
  });

  test("maps extra CLI and API wake options and catch branch returns captured logs", async () => {
    let result = await handler({
      source: "cli",
      args: ["neo", "task", "prompt", "tail", "--incubate", "org/repo", "--attach", "--list", "--dry-run", "--from-snapshot", "--snapshot", "snap", "--main", "--split", "--all-local"],
    } as any);
    expect(result.ok).toBe(true);
    expect(wakeCalls.at(-1)).toEqual({
      oracle: "neo",
      opts: {
        task: "task",
        prompt: "prompt tail",
        incubate: "org/repo",
        attach: true,
        listWt: true,
        dryRun: true,
        fromSnapshot: true,
        snapshotId: "snap",
        noRehydrate: true,
        split: true,
        allLocal: true,
      },
    });

    result = await handler({
      source: "api",
      args: { oracle: "api", task: "t", prompt: "p", issue: 4, repo: "org/repo", fresh: true, attach: true, fromSnapshot: true },
    } as any);
    expect(result.ok).toBe(true);
    expect(fetchPromptCalls).toEqual([{ kind: "issue", num: 4, repo: "org/repo" }]);
    expect(wakeCalls.at(-1)?.opts).toMatchObject({ task: "t", prompt: "issue-4-prompt", fresh: true, attach: true, fromSnapshot: true });

    wakeThrow = new Error("wake failed");
    result = await handler({ source: "cli", args: ["bad"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wake bad");
    expect(result.output).toContain("wake bad");
  });
});
