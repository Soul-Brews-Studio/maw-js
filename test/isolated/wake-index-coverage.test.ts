import { beforeEach, describe, expect, mock, test } from "bun:test";

const wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];
const wakeAllCalls: Array<Record<string, unknown>> = [];
const parseTargetCalls: string[] = [];
const ensureClonedCalls: string[] = [];
const fetchPromptCalls: Array<{ kind: string; num: number; repo?: string }> = [];
const peerResolvePath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts");
const peerCallPath = import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts");
const peerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

let parsedTarget: null | { oracle: string; slug: string; issueNum?: number } = null;
let fetchedPrompt = "fetched prompt";
let peersByAlias = new Map<string, { url: string }>();
let peerWakeResult: { ok: boolean; status?: number; data?: any } = { ok: true, data: {} };
let peerWakeError: Error | null = null;

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    console.log(`wake ${oracle}`);
  },
}));

mock.module("maw-js/commands/shared/fleet", () => ({
  cmdWakeAll: async (opts: Record<string, unknown>) => {
    wakeAllCalls.push(opts);
    console.log("wake all invoked");
  },
}));

mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: (target: string) => {
    parseTargetCalls.push(target);
    return parsedTarget;
  },
  ensureCloned: async (slug: string) => {
    ensureClonedCalls.push(slug);
  },
}));

mock.module("maw-js/commands/shared/wake-resolve", () => ({
  fetchGitHubPrompt: async (kind: string, num: number, repo?: string) => {
    fetchPromptCalls.push({ kind, num, repo });
    return fetchedPrompt;
  },
}));

mock.module(peerResolvePath, () => ({
  resolvePeer: (alias: string) => peersByAlias.get(alias) ?? null,
}));

mock.module(peerCallPath, () => ({
  callPeerWake: async (url: string, body: Record<string, unknown>) => {
    peerCalls.push({ url, body });
    if (peerWakeError) throw peerWakeError;
    return peerWakeResult;
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/wake/index.ts?wake-index-coverage");

beforeEach(() => {
  wakeCalls.length = 0;
  wakeAllCalls.length = 0;
  parseTargetCalls.length = 0;
  ensureClonedCalls.length = 0;
  fetchPromptCalls.length = 0;
  parsedTarget = null;
  fetchedPrompt = "fetched prompt";
  peersByAlias = new Map();
  peerWakeResult = { ok: true, data: {} };
  peerWakeError = null;
  peerCalls.length = 0;
});

describe("wake plugin index", () => {
  test("exports wake command metadata", () => {
    expect(command).toEqual({
      name: "wake",
      description: "Spawn or attach to an oracle session",
    });
  });

  test("returns usage when cli args omit the wake target", async () => {
    const result = await handler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw wake <oracle|org/repo|URL>");
    expect(wakeCalls).toEqual([]);
  });

  test("dispatches wake all with parsed fleet flags", async () => {
    const result = await handler({ source: "cli", args: ["all", "--kill", "--resume"] } as any);

    expect(result).toEqual({ ok: true, output: "wake all invoked" });
    expect(wakeAllCalls).toEqual([{ kill: true, all: undefined, resume: true }]);
  });

  test("maps cli repo issue target into cloned repo wake options", async () => {
    parsedTarget = { oracle: "repo-oracle", slug: "Soul-Brews-Studio/maw-js", issueNum: 42 };
    fetchedPrompt = "issue body";

    const result = await handler({
      source: "cli",
      args: ["https://github.com/Soul-Brews-Studio/maw-js/issues/42", "--new", "--no-attach"],
    } as any);

    expect(result.ok).toBe(true);
    expect(parseTargetCalls).toEqual(["https://github.com/Soul-Brews-Studio/maw-js/issues/42"]);
    expect(ensureClonedCalls).toEqual(["Soul-Brews-Studio/maw-js"]);
    expect(fetchPromptCalls).toEqual([{ kind: "issue", num: 42, repo: "Soul-Brews-Studio/maw-js" }]);
    expect(wakeCalls).toEqual([
      {
        oracle: "repo-oracle",
        opts: {
          urlRepoName: "maw-js",
          fresh: true,
          attach: false,
          prompt: "issue body",
          task: "issue-42",
        },
      },
    ]);
  });

  test("maps cli reusable worktree picker flags", async () => {
    const result = await handler({
      source: "cli",
      args: ["homekeeper", "--wt", "white", "--layout", "legacy", "--pick", "--name", "osmosis"],
    } as any);

    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual([
      {
        oracle: "homekeeper",
        opts: {
          wt: "white",
          layout: "legacy",
          pick: true,
          name: "osmosis",
        },
      },
    ]);
  });

  test("maps the remaining cli flags, positionals, and explicit task prompt", async () => {
    const result = await handler({
      source: "cli",
      args: [
        "neo", "task-name", "prompt", "words",
        "--incubate", "Soul-Brews-Studio/maw-js",
        "--attach", "--ls", "--dry-run", "--snapshot", "snap-2",
        "--solo", "--split", "--all-local", "--task", "flag prompt",
      ],
    } as any);

    expect(result.ok).toBe(true);
    expect(wakeCalls).toEqual([{
      oracle: "neo",
      opts: {
        incubate: "Soul-Brews-Studio/maw-js",
        attach: true,
        listWt: true,
        dryRun: true,
        snapshotId: "snap-2",
        fromSnapshot: true,
        noRehydrate: true,
        split: true,
        allLocal: true,
        task: "task-name",
        prompt: "flag prompt",
      },
    }]);
    expect(fetchPromptCalls).toEqual([]);
  });

  test("maps cli PR fetches and captures writer output without buffered output", async () => {
    fetchedPrompt = "pr prompt";
    const written: string[] = [];

    const result = await handler({
      source: "cli",
      args: ["neo", "--pr", "9", "--repo", "owner/repo"],
      writer: (...parts: unknown[]) => written.push(parts.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(fetchPromptCalls).toEqual([{ kind: "pr", num: 9, repo: "owner/repo" }]);
    expect(wakeCalls).toEqual([{ oracle: "neo", opts: { prompt: "pr prompt", task: "pr-9" } }]);
    expect(written.join("\\n")).toContain("fetching PR #9");
    expect(written.join("\\n")).toContain("wake neo");
  });

  test("maps api issue body into wake options without overriding explicit task", async () => {
    fetchedPrompt = "issue body";

    const result = await handler({
      source: "api",
      args: {
        oracle: "trinity",
        issue: 12,
        repo: "owner/repo",
        task: "custom-task",
        prompt: "manual prompt",
        fresh: true,
        attach: true,
        main: true,
        fromSnapshot: true,
      },
    } as any);

    expect(result).toEqual({ ok: true, output: "wake trinity" });
    expect(fetchPromptCalls).toEqual([{ kind: "issue", num: 12, repo: "owner/repo" }]);
    expect(wakeCalls).toEqual([{
      oracle: "trinity",
      opts: {
        task: "custom-task",
        prompt: "issue body",
        fresh: true,
        attach: true,
        noRehydrate: true,
        fromSnapshot: true,
      },
    }]);
  });

  test("maps api pr body into wake options", async () => {
    fetchedPrompt = "pr body";

    const result = await handler({
      source: "api",
      args: {
        oracle: "neo",
        pr: 7,
        repo: "owner/repo",
        wt: "feature-slot",
        pick: true,
        name: "named-slot",
        layout: "nested",
        dryRun: true,
        solo: true,
        snapshot: "snap-1",
      },
    } as any);

    expect(result).toEqual({ ok: true, output: "wake neo" });
    expect(fetchPromptCalls).toEqual([{ kind: "pr", num: 7, repo: "owner/repo" }]);
    expect(wakeCalls).toEqual([
      {
        oracle: "neo",
        opts: {
          wt: "feature-slot",
          pick: true,
          name: "named-slot",
          layout: "nested",
          prompt: "pr body",
          task: "pr-7",
          dryRun: true,
          noRehydrate: true,
          snapshotId: "snap-1",
          fromSnapshot: true,
        },
      },
    ]);
  });

  test("returns missing oracle for api bodies without oracle", async () => {
    const result = await handler({ source: "api", args: { task: "ignored" } } as any);

    expect(result).toEqual({ ok: false, error: "missing oracle name" });
    expect(wakeCalls).toEqual([]);
  });

  test("forwards cli wake requests to peers and maps peer failures", async () => {
    peersByAlias.set("gpu", { url: "http://gpu" });
    peerWakeResult = { ok: true, data: { output: "remote output" } };

    let result = await handler({
      source: "cli",
      args: ["neo", "remote-task", "--peer", "gpu", "--wt", "slot", "--layout", "legacy", "--task", "prompt", "--issue", "5", "--repo", "o/r", "--fresh", "--pick", "--name", "named"],
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("forwarded wake → gpu (http://gpu) — neo");
    expect(result.output).toContain("remote output");
    expect(peerCalls).toEqual([{
      url: "http://gpu",
      body: { oracle: "neo", task: "remote-task", wt: "slot", layout: "legacy", prompt: "prompt", issue: 5, repo: "o/r", fresh: true, pick: true, name: "named" },
    }]);
    expect(wakeCalls).toEqual([]);

    result = await handler({ source: "cli", args: ["neo", "--peer", "missing"] } as any);
    expect(result).toEqual({ ok: false, error: "unknown peer alias: missing (see: maw peers list)" });

    peerWakeResult = { ok: false, status: 404, data: {} };
    result = await handler({ source: "cli", args: ["neo", "--peer", "gpu"] } as any);
    expect(result).toEqual({ ok: false, error: "peer gpu does not support /api/wake (HTTP 404 at http://gpu)" });

    peerWakeResult = { ok: false, status: 500, data: { error: "boom" } };
    result = await handler({ source: "cli", args: ["neo", "--peer", "gpu"] } as any);
    expect(result).toEqual({ ok: false, error: "peer wake failed (gpu http://gpu): boom" });

    peerWakeError = new Error("network down");
    result = await handler({ source: "cli", args: ["neo", "--peer", "gpu"] } as any);
    expect(result).toEqual({ ok: false, error: "peer wake failed (gpu http://gpu): network down" });
  });
});
