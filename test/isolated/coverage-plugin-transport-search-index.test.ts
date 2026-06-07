import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PeerManifestResponse } from "../../src/api/plugin-list-manifest";
import type { CurlResponse } from "../../src/core/transport/curl-fetch";

type NamedPeer = { name: string; url: string };

let config: { namedPeers?: NamedPeer[] };
let peerUrls: string[];
let cacheDir: string;

mock.module(import.meta.resolve("../../src/config"), () => ({
  loadConfig: () => config,
}));

mock.module(import.meta.resolve("../../src/core/transport/peers"), () => ({
  getPeers: () => peerUrls,
}));

const search = await import("../../src/commands/plugins/plugin/search-peers.ts?coverage-plugin-transport-search");

const registryFetchPath = import.meta.resolve("../../src/commands/plugins/plugin/registry-fetch");
const registryResolvePath = import.meta.resolve("../../src/commands/plugins/plugin/registry-resolve");
const installImplPath = import.meta.resolve("../../src/commands/plugins/plugin/install-impl");
const searchPeersPath = import.meta.resolve("../../src/commands/plugins/plugin/search-peers");
const initImplPath = import.meta.resolve("../../src/commands/plugins/plugin/init-impl");
const buildImplPath = import.meta.resolve("../../src/commands/plugins/plugin/build-impl");
const lockCliPath = import.meta.resolve("../../src/commands/plugins/plugin/lock-cli");

let registry: any;
let peerSearchResult: any;
let installedSources: string[];
let subcommandCalls: string[];

mock.module(registryFetchPath, () => ({
  registryUrl: () => "https://registry.example.test/plugins.json",
  getRegistry: async () => registry,
}));

mock.module(registryResolvePath, () => ({
  resolvePluginSource: (name: string, reg: any) =>
    reg.plugins?.[name] ? { source: `source:${name}` } : null,
}));

mock.module(installImplPath, () => ({
  cmdPluginInstall: async (args: string[]) => {
    installedSources.push(args[0] ?? "");
    if ((args[0] ?? "").includes("module-missing")) throw new Error("Cannot find module './install'");
    if ((args[0] ?? "").includes("fail")) throw new Error("install failed");
  },
}));

mock.module(searchPeersPath, () => ({
  searchPeers: async () => peerSearchResult,
}));

mock.module(initImplPath, () => ({
  cmdPluginInit: async (args: string[]) => subcommandCalls.push(`init:${args.join(",")}`),
}));

mock.module(buildImplPath, () => ({
  cmdPluginBuild: async (args: string[]) => subcommandCalls.push(`build:${args.join(",")}`),
  cmdPluginDev: async (args: string[]) => subcommandCalls.push(`dev:${args.join(",")}`),
}));

mock.module(lockCliPath, () => ({
  cmdPluginPin: async (args: string[]) => subcommandCalls.push(`pin:${args.join(",")}`),
  cmdPluginUnpin: async (args: string[]) => subcommandCalls.push(`unpin:${args.join(",")}`),
}));

const pluginIndex = await import("../../src/commands/plugins/plugin/index");

function manifestOk(node: string, plugins: PeerManifestResponse["plugins"]): PeerManifestResponse {
  return {
    schemaVersion: 1,
    node,
    pluginCount: plugins.length,
    plugins,
  };
}

function responseOk(node: string, plugins: PeerManifestResponse["plugins"]): CurlResponse {
  return {
    ok: true,
    status: 200,
    data: manifestOk(node, plugins),
  };
}

function cacheFile(url: string): string {
  return join(cacheDir, `${encodeURIComponent(url).replace(/%/g, "_")}.json`);
}

function invokePlugin(args: string[]) {
  return pluginIndex.default({ source: "cli", args } as any);
}

beforeEach(() => {
  config = { namedPeers: [] };
  peerUrls = [];
  cacheDir = mkdtempSync(join(tmpdir(), "maw-plugin-transport-search-"));
  registry = {
    updated: "2026-05-18T00:00:00.000Z",
    plugins: {},
    packages: {},
  };
  peerSearchResult = {
    hits: [],
    queried: 0,
    responded: 0,
    errors: [],
    elapsedMs: 0,
  };
  installedSources = [];
  subcommandCalls = [];
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("peer search coverage", () => {
  test("peerCacheDir honors explicit, environment, and home defaults", () => {
    const original = process.env.MAW_PEER_CACHE_DIR;
    try {
      process.env.MAW_PEER_CACHE_DIR = "/tmp/peer-cache-env";
      expect(search.peerCacheDir("/tmp/peer-cache-override")).toBe("/tmp/peer-cache-override");
      expect(search.peerCacheDir()).toBe("/tmp/peer-cache-env");
      delete process.env.MAW_PEER_CACHE_DIR;
      expect(search.peerCacheDir()).toContain(".maw");
    } finally {
      if (original === undefined) delete process.env.MAW_PEER_CACHE_DIR;
      else process.env.MAW_PEER_CACHE_DIR = original;
    }
  });

  test("resolvePeers maps configured names, peer URLs, and unknown peer errors", () => {
    config = {
      namedPeers: [
        { name: "node-a", url: "http://a.example.test" },
        { name: "node-b", url: "http://b.example.test" },
      ],
    };
    peerUrls = ["http://b.example.test", "http://loose.example.test"];

    expect(search.resolvePeers({ peer: "node-a" })).toEqual([
      { url: "http://a.example.test", name: "node-a" },
    ]);
    expect(search.resolvePeers({})).toEqual([
      { url: "http://b.example.test", name: "node-b" },
      { url: "http://loose.example.test" },
    ]);
    expect(() => search.resolvePeers({ peer: "missing" })).toThrow("unknown peer 'missing'");
  });

  test("searchPeers returns immediately when there are no peers", async () => {
    const result = await search.searchPeers("tool", { peers: [] });

    expect(result).toMatchObject({
      hits: [],
      queried: 0,
      responded: 0,
      errors: [],
    });
  });

  test("fresh cache hits skip fetch, warn on identity mismatch, dedupe, and sort", async () => {
    const url = "http://cached-peer.example.test";
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      cacheFile(url),
      JSON.stringify({
        url,
        fetchedAt: new Date().toISOString(),
        manifest: manifestOk("reported-node", [
          { name: "gamma", version: "2.0.0", summary: "needle in summary", author: "Ada" },
          { name: "alpha", version: "1.0.0", summary: "needle first", sha256: "sha256:" + "a".repeat(64) },
          { name: "alpha", version: "2.0.0", summary: "needle second" },
          { name: "alpha", version: "1.0.0", summary: "needle duplicate" },
        ]),
      }),
      "utf8",
    );

    let calls = 0;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const result = await search.searchPeers("needle", {
        peers: [{ url, name: "configured-node" }],
        cacheDir,
        fetch: (async () => {
          calls++;
          return responseOk("configured-node", []);
        }) as any,
      });

      expect(calls).toBe(0);
      expect(result.responded).toBe(1);
      expect(result.hits.map((h: any) => `${h.name}@${h.version}`)).toEqual([
        "alpha@1.0.0",
        "alpha@2.0.0",
        "gamma@2.0.0",
      ]);
      expect(result.hits.every((h: any) => h.identityMismatch)).toBe(true);
      expect(result.hits[0]).toMatchObject({
        peerName: "configured-node",
        peerNode: "reported-node",
        sha256: "sha256:" + "a".repeat(64),
      });
      expect(warnings.join("\n")).toContain("identity mismatch");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("http failures keep status-specific reasons", async () => {
    const result = await search.searchPeers("tool", {
      peers: [
        { url: "http://offline.example.test", name: "offline" },
        { url: "http://unhappy.example.test", name: "unhappy" },
      ],
      noCache: true,
      totalMs: 50,
      fetch: (async (url: string) => ({
        ok: false,
        status: url.includes("offline") ? 0 : 503,
        data: null,
      })) as any,
    });

    expect(result.hits).toEqual([]);
    expect(result.errors.map((e: any) => [e.peerName, e.reason, e.detail])).toEqual([
      ["offline", "unreachable", "status 0"],
      ["unhappy", "http-error", "status 503"],
    ]);
  });

  test("stale or future-dated cache entries fall back to fetch and refresh cache", async () => {
    const url = "http://refresh.example.test";
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      cacheFile(url),
      JSON.stringify({
        url,
        fetchedAt: new Date(Date.now() + 60_000).toISOString(),
        manifest: manifestOk("old-node", [
          { name: "old-tool", version: "0.1.0", summary: "stale" },
        ]),
      }),
      "utf8",
    );

    let calls = 0;
    const result = await search.searchPeers("fresh", {
      peers: [{ url, name: "fresh-node" }],
      cacheDir,
      fetch: (async () => {
        calls++;
        return responseOk("fresh-node", [
          { name: "fresh-tool", version: "1.0.0", summary: "fresh summary" },
        ]);
      }) as any,
    });

    expect(calls).toBe(1);
    expect(result.hits[0]).toMatchObject({ name: "fresh-tool", peerNode: "fresh-node" });
  });

  test("fetch Error instances preserve message details", async () => {
    const result = await search.searchPeers("tool", {
      peers: [{ url: "http://error.example.test", name: "error-node" }],
      noCache: true,
      fetch: (async () => {
        throw new Error("socket refused");
      }) as any,
    });

    expect(result.errors[0]).toMatchObject({
      peerUrl: "http://error.example.test",
      peerName: "error-node",
      reason: "unreachable",
      detail: "socket refused",
    });
  });

  test("bad peer manifests are reported without throwing", async () => {
    const result = await search.searchPeers("tool", {
      peers: [{ url: "http://bad.example.test", name: "bad-node" }],
      noCache: true,
      fetch: (async () => ({
        ok: true,
        status: 200,
        data: { schemaVersion: 1, node: "bad-node", plugins: [{ name: "missing-version" }] },
      })) as any,
    });

    expect(result.errors).toEqual([
      {
        peerUrl: "http://bad.example.test",
        peerName: "bad-node",
        reason: "bad-response",
        detail: "missing schemaVersion=1/plugins[]",
      },
    ]);
  });

  test("total budget timeout returns synthetic timeout errors", async () => {
    const result = await search.searchPeers("tool", {
      peers: [{ url: "http://slow.example.test", name: "slow" }],
      noCache: true,
      totalMs: 1,
      fetch: (() => new Promise(() => undefined)) as any,
    });

    expect(result.responded).toBe(0);
    expect(result.errors).toEqual([
      {
        peerUrl: "http://slow.example.test",
        peerName: "slow",
        reason: "timeout",
        detail: "total budget 1ms exceeded",
      },
    ]);
  });
});

describe("plugin command coverage", () => {
  test("help, unknown, and simple delegated subcommands are routed", async () => {
    const help = await invokePlugin(["--help"]);
    expect(help.ok).toBe(true);
    expect(help.output).toContain("usage: maw plugin");

    expect(await invokePlugin(["init", "tool", "--ts"])).toMatchObject({ ok: true });
    expect(await invokePlugin(["build", "plugins/tool"])).toMatchObject({ ok: true });
    expect(await invokePlugin(["dev", "plugins/tool"])).toMatchObject({ ok: true });
    expect(await invokePlugin(["pin", "tool", "tool.tgz"])).toMatchObject({ ok: true });
    expect(await invokePlugin(["unpin", "tool"])).toMatchObject({ ok: true });
    expect(subcommandCalls).toEqual([
      "init:tool,--ts",
      "build:plugins/tool",
      "dev:plugins/tool",
      "pin:tool,tool.tgz",
      "unpin:tool",
    ]);

    const unknown = await invokePlugin(["mystery"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown plugin subcommand: mystery");
  });

  test("search reports missing query usage", async () => {
    const result = await invokePlugin(["search"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw plugin search");
  });

  test("search reports missing peer name usage", async () => {
    const result = await invokePlugin(["search", "needle", "--peer"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("--peer requires a name");
  });

  test("search prints registry miss, peer URL fallback, warnings, and peer errors", async () => {
    peerSearchResult = {
      queried: 2,
      responded: 1,
      elapsedMs: 1234,
      hits: [
        {
          name: "remote-tool",
          version: "1.2.3",
          peerUrl: "http://peer.example.test",
          peerNode: "node-x",
          identityMismatch: true,
        },
      ],
      errors: [{ peerUrl: "http://down.example.test", reason: "timeout" }],
    };

    const result = await invokePlugin(["search", "needle", "--peers"]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registry:\n  (no hits)");
    expect(result.output).toContain("peers (2 queried, 1 responded in 1.2s):");
    expect(result.output).toContain("remote-tool@1.2.3");
    expect(result.output).toContain("@http://peer.example.test");
    expect(result.output).toContain("[identity-mismatch]");
    expect(result.output).toContain("! http://down.example.test: timeout");
  });

  test("registry-only search prints the no-hit message", async () => {
    const result = await invokePlugin(["search", "absent"]);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('no plugins match "absent"');
  });

  test("registry search prints matching entries and peer-only no-hit output", async () => {
    registry = {
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        alpha: { version: "1.0.0", summary: "needle registry hit" },
      },
      packages: {},
    };
    peerSearchResult = {
      queried: 1,
      responded: 1,
      elapsedMs: 5,
      hits: [],
      errors: [],
    };

    const registryResult = await invokePlugin(["search", "needle"]);
    expect(registryResult.output).toBe("alpha@1.0.0  needle registry hit");

    const peerOnly = await invokePlugin(["search", "needle", "--peers-only"]);
    expect(peerOnly.output).toContain("peers (1 queried, 1 responded in 0.0s):");
    expect(peerOnly.output).toContain("  (no hits)");
  });

  test("registry and info subcommands print registry metadata", async () => {
    registry = {
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        tool: {
          version: "1.2.3",
          summary: "useful tool",
          source: "source:tool",
          sha256: null,
          author: "Ada",
          license: "BUSL-1.1",
          homepage: "https://example.test/tool",
          addedAt: "2026-05-18T00:00:00.000Z",
        },
      },
      packages: {},
    };

    const registryResult = await invokePlugin(["registry"]);
    expect(registryResult.ok).toBe(true);
    expect(registryResult.output).toContain("registry: https://registry.example.test/plugins.json");
    expect(registryResult.output).toContain("plugins:  1");

    const infoResult = await invokePlugin(["info", "tool"]);
    expect(infoResult.ok).toBe(true);
    expect(infoResult.output).toContain("tool@1.2.3");
    expect(infoResult.output).toContain("sha256:   (unpinned)");
    expect(infoResult.output).toContain("homepage: https://example.test/tool");
  });

  test("package install reports partial failures after recursive installs", async () => {
    registry = {
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        "ok-plugin": { source: "source:ok-plugin", summary: "ok", version: "1.0.0" },
        "fail-plugin": { source: "source:fail-plugin", summary: "fail", version: "1.0.0" },
      },
      packages: {
        bundle: {
          summary: "two plugin package",
          plugins: ["ok-plugin", "fail-plugin"],
        },
      },
    };

    const result = await invokePlugin(["install", "bundle", "--pin"]);

    expect(result.ok).toBe(false);
    expect(installedSources).toEqual(["source:ok-plugin", "source:fail-plugin"]);
    expect(result.error).toContain("installing package 'bundle': 2 plugins");
    expect(result.error).toContain("! fail-plugin: install failed");
    expect(result.error).toContain("package 'bundle': 1/2 installed (1 failed)");
  });

  test("package install succeeds, unknown plain names list packages, and missing implementation has fallback", async () => {
    registry = {
      updated: "2026-05-18T00:00:00.000Z",
      plugins: {
        "ok-plugin": { source: "source:ok-plugin", summary: "ok", version: "1.0.0" },
        "module-missing": { source: "source:module-missing", summary: "missing", version: "1.0.0" },
      },
      packages: {
        bundle: {
          summary: "single plugin package",
          plugins: ["ok-plugin"],
        },
      },
    };

    const ok = await invokePlugin(["install", "bundle"]);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("package 'bundle': 1/1 installed");

    const unknown = await invokePlugin(["install", "ghost"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("packages available: bundle");

    const missing = await invokePlugin(["install", "module-missing"]);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("plugin install: not yet implemented");

    const direct = await invokePlugin(["install", "./local-plugin"]);
    expect(direct.ok).toBe(true);
    expect(installedSources).toContain("./local-plugin");
  });
});
