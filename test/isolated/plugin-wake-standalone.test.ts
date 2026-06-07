import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type WakeCall = { oracle: string; opts: Record<string, unknown> };
const wakeCalls: WakeCall[] = [];
const wakeAllCalls: Record<string, unknown>[] = [];
const cloned: string[] = [];
const githubPrompts: Array<{ kind: string; num: number; repo?: string }> = [];
const peerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let peerResponse: { ok: boolean; status?: number; data?: any } = { ok: true, data: { output: "remote woke" } };
let tmpHome = "";

function simpleParseFlags(args: string[], spec: Record<string, unknown>, start = 0) {
  const out: Record<string, any> & { _: string[] } = { _: [] };
  for (let i = start; i < args.length; i += 1) {
    const arg = args[i]!;
    const parser = spec[arg];
    if (!parser) {
      out._.push(arg);
    } else if (typeof parser === "string") {
      out[parser] = true;
    } else if (parser === Boolean) {
      out[arg] = true;
    } else if (parser === Number) {
      out[arg] = Number(args[++i]);
    } else if (parser === String) {
      out[arg] = args[++i];
    }
  }
  return out;
}

const sdkMock = {
  parseFlags: simpleParseFlags,
  mawStatePath: (name: string) => join(tmpHome, "state", name),
  legacyMawPath: (name: string) => join(tmpHome, "legacy", name),
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(new URL("../../src/sdk/index.ts", import.meta.url).pathname, () => ({ ...realSdk, ...sdkMock }));

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => wakeCalls.push({ oracle, opts }),
}));
mock.module("maw-js/commands/shared/fleet", () => ({
  cmdWakeAll: async (opts: Record<string, unknown>) => wakeAllCalls.push({ ...opts }),
}));
mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: (target: string) => target.startsWith("https://github.com/")
    ? { oracle: "repo", slug: target.replace("https://github.com/", ""), issueNum: null }
    : null,
  ensureCloned: async (slug: string) => cloned.push(slug),
}));
mock.module("maw-js/commands/shared/wake-resolve", () => ({
  fetchGitHubPrompt: async (kind: string, num: number, repo?: string) => {
    githubPrompts.push({ kind, num, repo });
    return `${kind} #${num} prompt`;
  },
}));
const peerCallMock = {
  callPeerWake: async (url: string, body: Record<string, unknown>) => {
    peerCalls.push({ url, body: structuredClone(body) });
    return peerResponse;
  },
};
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call"), () => peerCallMock);
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts"), () => peerCallMock);
mock.module(new URL("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts", import.meta.url).pathname, () => peerCallMock);

const { default: wakeHandler } = await import("../../src/vendor/mpr-plugins/wake/index.ts?plugin-wake-standalone");
const peerResolve = await import("../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts?plugin-wake-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  wakeCalls.length = 0;
  wakeAllCalls.length = 0;
  cloned.length = 0;
  githubPrompts.length = 0;
  peerCalls.length = 0;
  peerResponse = { ok: true, data: { output: "remote woke" } };
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = mkdtempSync(join(tmpdir(), "maw-wake-standalone-"));
  process.env.PEERS_FILE = join(tmpHome, "peers.json");
});

describe("wake plugin standalone boundary", () => {
  test("routes former cli/core helpers through SDK boundary", () => {
    for (const rel of [
      "src/vendor/mpr-plugins/wake/index.ts",
      "src/vendor/mpr-plugins/wake/internal/peer-resolve.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:cli|core)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/\.\.\/(?:core|cli)/);
    }
    const sdk = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    expect(sdk).toContain("parseFlags");
    expect(sdk).toContain("mawStatePath");
    expect(sdk).toContain("legacyMawPath");
  });

  test("cli wake all and normal wake parse flags through mocked shared commands", async () => {
    const all = await wakeHandler({ source: "cli", args: ["all", "--kill", "--resume"] } as any);
    expect(all.ok).toBe(true);
    expect(wakeAllCalls).toEqual([{ kill: true, all: undefined, resume: true }]);

    const normal = await wakeHandler({
      source: "cli",
      args: ["mawjs", "work", "prompt", "words", "--layout", "nested", "--new", "--name", "stable", "--attach", "--dry-run", "--keep-last", "3", "--max-age", "5", "--parent", "parent-1", "--session-id", "session-1"],
    } as any);
    expect(normal.ok).toBe(true);
    expect(wakeCalls).toEqual([{ oracle: "mawjs", opts: {
      layout: "nested",
      fresh: true,
      name: "stable",
      attach: true,
      dryRun: true,
      snapshotRetention: { keepLast: 3, maxAgeDays: 5 },
      parentSessionId: "parent-1",
      sessionId: "session-1",
      task: "work",
      prompt: "prompt words",
    } }]);
  });

  test("cli URL/issue and API PR paths fetch prompts without loading real core", async () => {
    const cli = await wakeHandler({ source: "cli", args: ["https://github.com/Soul/repo-oracle", "--issue", "7"] } as any);
    expect(cli.ok).toBe(true);
    expect(cloned).toEqual(["Soul/repo-oracle"]);
    expect(githubPrompts).toEqual([{ kind: "issue", num: 7, repo: undefined }]);
    expect(wakeCalls[0]).toEqual({ oracle: "repo", opts: { urlRepoName: "repo-oracle", prompt: "issue #7 prompt", task: "issue-7" } });

    const api = await wakeHandler({ source: "api", args: { oracle: "neo", pr: 9, repo: "Soul/neo", solo: true, snapshot: "snap-1" } } as any);
    expect(api.ok).toBe(true);
    expect(githubPrompts.at(-1)).toEqual({ kind: "pr", num: 9, repo: "Soul/neo" });
    expect(wakeCalls.at(-1)).toEqual({ oracle: "neo", opts: { prompt: "pr #9 prompt", task: "pr-9", noRehydrate: true, snapshotId: "snap-1", fromSnapshot: true } });
  });

  test("peer resolver and --peer forwarding stay isolated from real peer store", async () => {
    writeFileSync(process.env.PEERS_FILE!, JSON.stringify({ peers: { gpu: { url: "https://gpu.invalid", node: "gpu-node" } } }));
    expect(peerResolve.resolvePeer("gpu")).toEqual({ url: "https://gpu.invalid", node: "gpu-node" });

    const res = await wakeHandler({ source: "cli", args: ["neo", "task", "--peer", "gpu", "--wt", "slot", "--task", "remote prompt", "--issue", "11", "--repo", "Soul/neo", "--fresh", "--pick", "--name", "stable"] } as any);
    expect(res.ok).toBe(true);
    expect(stripAnsi(res.output)).toContain("forwarded wake → gpu");
    expect(peerCalls).toEqual([{ url: "https://gpu.invalid", body: {
      oracle: "neo",
      task: "task",
      wt: "slot",
      prompt: "remote prompt",
      issue: 11,
      repo: "Soul/neo",
      fresh: true,
      pick: true,
      name: "stable",
    } }]);
  });
});
