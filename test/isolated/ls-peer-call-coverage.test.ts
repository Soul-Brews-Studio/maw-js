/**
 * Isolated coverage for src/vendor/mpr-plugins/ls/internal/peer-call.ts.
 *
 * Isolated because this file mocks maw-js/sdk (mock.module is process-global)
 * while exercising the dynamic import seam used by fetchPeerSessions().
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let curlFetchCalls: Array<{ url: string; options: any }> = [];
let curlFetchHandler: (url: string, options: any) => any = () => ({ ok: true, status: 200, data: [] });
let localSessions: any[] = [];
let localConfig: Record<string, unknown> = { node: "m5", oracle: "mawjs" };
let hostExecHandler: (cmd: string) => string | Promise<string> = () => "";

mock.module("maw-js/sdk", () => ({
  curlFetch: async (url: string, options: any) => {
    curlFetchCalls.push({ url, options });
    return await curlFetchHandler(url, options);
  },
  listSessions: async () => localSessions,
  loadConfig: () => localConfig,
  hostExec: async (cmd: string) => await hostExecHandler(cmd),
  tmuxCmd: () => "tmux",
}));

const { fetchPeerSessions, localLsPayload, lsAllPeers, lsFederated, lsPeer } = await import("../../src/vendor/mpr-plugins/ls/internal/peer-call");

let tempDir = "";
let previousPeersFile: string | undefined;

function writePeers(peers: Record<string, { url?: string; node?: string }>) {
  writeFileSync(join(tempDir, "peers.json"), JSON.stringify({ peers }), "utf-8");
  process.env.PEERS_FILE = join(tempDir, "peers.json");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "maw-ls-peer-call-"));
  previousPeersFile = process.env.PEERS_FILE;
  process.env.PEERS_FILE = join(tempDir, "missing-peers.json");
  curlFetchCalls = [];
  curlFetchHandler = () => ({ ok: true, status: 200, data: [] });
  localSessions = [];
  localConfig = { node: "m5", oracle: "mawjs" };
  hostExecHandler = () => "";
});

afterEach(() => {
  if (previousPeersFile === undefined) delete process.env.PEERS_FILE;
  else process.env.PEERS_FILE = previousPeersFile;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("fetchPeerSessions", () => {
  test("calls /api/ls with federation signing and the 2s default timeout", async () => {
    curlFetchHandler = () => ({ ok: true, status: 200, data: [{ name: "alpha", windows: [] }] });

    const result = await fetchPeerSessions("http://peer.local:3456");

    expect(result).toEqual({ ok: true, status: 200, data: [{ name: "alpha", windows: [] }] });
    expect(curlFetchCalls).toEqual([
      {
        url: "http://peer.local:3456/api/ls",
        options: { method: "GET", from: "auto", timeout: 2000 },
      },
    ]);
  });

  test("honors a caller-provided timeout without starting subprocesses or network", async () => {
    curlFetchHandler = () => ({ ok: true, status: 200, data: [] });

    await fetchPeerSessions("http://peer.local", 123);

    expect(curlFetchCalls[0]).toEqual({
      url: "http://peer.local/api/ls",
      options: { method: "GET", from: "auto", timeout: 123 },
    });
  });
});


describe("localLsPayload and lsFederated", () => {
  test("returns this node session data for the /api/ls payload", async () => {
    localSessions = [{ name: "77-mawjs", windows: [{ name: "main", index: 1, active: true }] }];

    const payload = await localLsPayload();

    expect(payload).toEqual({
      alias: "m5",
      node: "m5",
      oracle: "mawjs",
      local: true,
      sessions: [{ name: "77-mawjs", windows: [{ name: "main", index: 1, active: true }] }],
    });
  });

  test("renders local plus peers by default and keeps unreachable peers as warning rows", async () => {
    writePeers({
      white: { url: "http://white.local", node: "white" },
      slow: { url: "http://slow.local", node: "slow" },
    });
    localSessions = [{ name: "77-mawjs", windows: [] }];
    curlFetchHandler = (url) => {
      if (url.startsWith("http://white.local")) {
        return { ok: true, status: 200, data: { ok: true, output: JSON.stringify({ node: "white", sessions: [{ name: "alpha", windows: [] }] }) } };
      }
      return { ok: false, status: 0, data: null };
    };

    const result = await lsFederated({ json: false });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("fleet view · 2/3 nodes reachable · 2 sessions total");
    expect(result.output).toContain("77-mawjs");
    expect(result.output).toContain("alpha");
    expect(result.output).toContain("slow");
    expect(result.output).toContain("no response");
    expect(curlFetchCalls.map((call) => call.url)).toEqual([
      "http://white.local/api/ls",
      "http://slow.local/api/ls",
    ]);
  });

  test("emits machine-readable federation JSON", async () => {
    writePeers({ white: { url: "http://white.local" } });
    localSessions = [{ name: "local", windows: [] }];
    curlFetchHandler = () => ({ ok: true, status: 200, data: [{ name: "remote", windows: [] }] });

    const result = await lsFederated({ json: true });
    const parsed = JSON.parse(result.output ?? "{}");

    expect(result.ok).toBe(true);
    expect(parsed.totalSessions).toBe(2);
    expect(parsed.reachableNodes).toBe(2);
    expect(parsed.nodes.map((node: any) => node.sessions.map((s: any) => s.name))).toEqual([["local"], ["remote"]]);
  });

  test("parses legacy /api/ls InvokeResult output with ANSI presentation instead of dropping sessions", async () => {
    writePeers({ alpha: { url: "http://alpha.local", node: "alpha" } });
    curlFetchHandler = () => ({
      ok: true,
      status: 200,
      data: { ok: true, output: "\x1b[36mvolt-oracle\x1b[0m\n  \x1b[32m●\x1b[0m 0: claude\n  \x1b[90m●\x1b[0m 1: logs" },
    });

    const result = await lsFederated({ json: true, includeLocal: false });
    const parsed = JSON.parse(result.output ?? "{}");

    expect(result.ok).toBe(true);
    expect(parsed.totalSessions).toBe(1);
    expect(parsed.nodes[0].sessions).toEqual([
      { name: "volt-oracle", windows: [{ index: 0, name: "claude", active: true }, { index: 1, name: "logs", active: false }] },
    ]);
  });
});


describe("lsPeer", () => {
  test("renders a successful peer session listing", async () => {
    writePeers({ clinic: { url: "http://clinic.local:3456", node: "clinic-node" } });
    curlFetchHandler = () => ({
      ok: true,
      status: 200,
      data: [
        {
          name: "codex",
          source: "remote-node",
          windows: [
            { name: "oracle", index: 0, active: true },
            { name: "logs", index: 1, active: false },
          ],
        },
      ],
    });

    const result = await lsPeer("clinic", { json: false });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("📡 clinic");
    expect(result.output).toContain("1 session");
    expect(result.output).toContain("codex");
    expect(result.output).toContain("via remote-node");
    expect(result.output).toContain("0: oracle");
    expect(result.output).toContain("maw hey clinic:<session>:<window>");
  });

  test("returns JSON for successful peer sessions", async () => {
    writePeers({ white: { url: "http://white.local:3456" } });
    curlFetchHandler = () => ({ ok: true, status: 200, data: [{ name: "m5", windows: [] }] });

    const result = await lsPeer("white", { json: true });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output ?? "{}")).toEqual({
      peer: "white",
      url: "http://white.local:3456",
      sessions: [{ name: "m5", windows: [] }],
    });
  });


  test("renders an empty peer session listing", async () => {
    writePeers({ empty: { url: "http://empty.local:3456" } });
    curlFetchHandler = () => ({ ok: true, status: 200, data: [] });

    const result = await lsPeer("empty", { json: false });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("0 sessions");
    expect(result.output).toContain("(no sessions)");
  });

  test("returns a deterministic no-peer error without calling fetch", async () => {
    writePeers({ other: { url: "http://other.local:3456" } });

    const result = await lsPeer("missing", { json: false });

    expect(result).toEqual({ ok: false, error: "unknown peer alias: missing (see: maw peers list)" });
    expect(curlFetchCalls).toHaveLength(0);
  });


  test("treats a malformed peer store as no matching peer", async () => {
    writeFileSync(join(tempDir, "peers.json"), "{not-json", "utf-8");
    process.env.PEERS_FILE = join(tempDir, "peers.json");

    const result = await lsPeer("broken", { json: false });

    expect(result).toEqual({ ok: false, error: "unknown peer alias: broken (see: maw peers list)" });
    expect(curlFetchCalls).toHaveLength(0);
  });

  test("maps HTTP errors to user-facing messages", async () => {
    writePeers({ old: { url: "http://old.local" }, locked: { url: "http://locked.local" }, down: { url: "http://down.local" }, silent: { url: "http://silent.local" } });
    curlFetchHandler = (url) => {
      if (url.startsWith("http://old.local")) return { ok: false, status: 404, data: {} };
      if (url.startsWith("http://locked.local")) return { ok: false, status: 403, data: {} };
      if (url.startsWith("http://silent.local")) return { ok: false };
      return { ok: false, status: 502, data: { error: "bad gateway" } };
    };

    await expect(lsPeer("old", { json: false })).resolves.toEqual({
      ok: false,
      error: "peer old does not support /api/ls (HTTP 404 at http://old.local)",
    });
    await expect(lsPeer("locked", { json: false })).resolves.toEqual({
      ok: false,
      error: "peer locked rejected (HTTP 403 at http://locked.local) — check federationToken / peer-identity keys",
    });
    await expect(lsPeer("down", { json: false })).resolves.toEqual({
      ok: false,
      error: "peer ls failed (down http://down.local): bad gateway",
    });
    await expect(lsPeer("silent", { json: false })).resolves.toEqual({
      ok: false,
      error: "peer ls failed (silent http://silent.local): no response",
    });
  });

  test("reports thrown timeout errors without a stack trace", async () => {
    writePeers({ slow: { url: "http://slow.local" } });
    curlFetchHandler = () => {
      throw new Error("request timed out after 2000ms");
    };

    const result = await lsPeer("slow", { json: false });

    expect(result).toEqual({
      ok: false,
      error: "peer ls failed (slow http://slow.local): request timed out after 2000ms",
    });
  });
});

describe("lsAllPeers", () => {
  test("returns a no-peer error when the peer store is empty or absent", async () => {
    const result = await lsAllPeers({ json: false });

    expect(result).toEqual({ ok: false, error: "no peers configured (see: maw peers add)" });
    expect(curlFetchCalls).toHaveLength(0);
  });

  test("aggregates success and per-peer errors without short-circuiting", async () => {
    writePeers({
      white: { url: "http://white.local" },
      slow: { url: "http://slow.local" },
      broken: { url: "http://broken.local" },
      ignored: { node: "no-url" },
    });
    curlFetchHandler = (url) => {
      if (url.startsWith("http://white.local")) return { ok: true, status: 200, data: [{ name: "alpha", windows: [] }] };
      if (url.startsWith("http://slow.local")) throw new Error("timeout");
      return { ok: false, status: 500, data: { error: "offline" } };
    };

    const result = await lsAllPeers({ json: true });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output ?? "{}")).toEqual({
      peers: [
        { alias: "white", url: "http://white.local", sessions: [{ name: "alpha", windows: [] }] },
        { alias: "slow", url: "http://slow.local", error: "peer ls failed (slow http://slow.local): timeout" },
        { alias: "broken", url: "http://broken.local", error: "peer ls failed (broken http://broken.local): offline" },
      ],
    });
    expect(curlFetchCalls.map((call) => call.url)).toEqual([
      "http://white.local/api/ls",
      "http://slow.local/api/ls",
      "http://broken.local/api/ls",
    ]);
  });

  test("renders fleet text with totals, empty peers, and error rows", async () => {
    writePeers({ white: { url: "http://white.local" }, empty: { url: "http://empty.local" }, locked: { url: "http://locked.local" } });
    curlFetchHandler = (url) => {
      if (url.startsWith("http://white.local")) return { ok: true, status: 200, data: [{ name: "alpha", source: "remote", windows: [] }] };
      if (url.startsWith("http://empty.local")) return { ok: true, status: 200, data: [] };
      return { ok: false, status: 401, data: {} };
    };

    const result = await lsAllPeers({ json: false });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("fleet view · 3 peers · 1 session total");
    expect(result.output).toContain("white");
    expect(result.output).toContain("alpha");
    expect(result.output).toContain("via remote");
    expect(result.output).toContain("empty");
    expect(result.output).toContain("0 sessions");
    expect(result.output).toContain("locked");
    expect(result.output).toContain("HTTP 401");
    expect(result.output).toContain("maw ls <peer>");
  });
});
