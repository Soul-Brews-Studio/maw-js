/**
 * Targeted isolated coverage for src/commands/plugins/plugin/index.ts.
 *
 * The plugin command index is mostly dispatch and output shaping. Dependency
 * modules are mocked so these tests exercise index-level routing without
 * touching the network, filesystem plugin installs, or peer discovery.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const registryFetchPath = import.meta.resolve("../../src/commands/plugins/plugin/registry-fetch");
const registryResolvePath = import.meta.resolve("../../src/commands/plugins/plugin/registry-resolve");
const installImplPath = import.meta.resolve("../../src/commands/plugins/plugin/install-impl");
const searchPeersPath = import.meta.resolve("../../src/commands/plugins/plugin/search-peers");

type RegistryEntry = {
  version: string;
  source: string;
  sha256: string | null;
  summary: string;
  author: string;
  license: string;
  homepage?: string;
  addedAt: string;
};

type RegistryManifest = {
  schemaVersion: 1;
  updated: string;
  plugins: Record<string, RegistryEntry>;
  packages?: Record<string, { summary: string; plugins: string[] }>;
};

type SearchPeersResult = {
  hits: Array<{
    name: string;
    version: string;
    summary?: string;
    peerName?: string;
    peerNode?: string;
    peerUrl: string;
    identityMismatch?: boolean;
  }>;
  queried: number;
  responded: number;
  elapsedMs: number;
  errors: Array<{ peerName?: string; peerUrl: string; reason: string; detail?: string }>;
};

const alphaEntry: RegistryEntry = {
  version: "1.2.3",
  source: "https://registry.example/alpha.tgz",
  sha256: "sha256:alpha",
  summary: "Alpha tools",
  author: "Maw Test",
  license: "MIT",
  homepage: "https://example.test/alpha",
  addedAt: "2026-05-01",
};

let registryUrlValue = "https://registry.example/registry.json";
let registryManifest: RegistryManifest;
let resolvedSource: { source: string } | null;
let installCalls: string[][];
let installFailureForSource: string | null;
let peerSearchResult: SearchPeersResult;
let peerSearchCalls: Array<{ query: string; opts: { peer?: string } }>;

mock.module(registryFetchPath, () => ({
  registryUrl: () => registryUrlValue,
  getRegistry: async () => registryManifest,
}));

mock.module(registryResolvePath, () => ({
  resolvePluginSource: () => resolvedSource,
}));

mock.module(installImplPath, () => ({
  cmdPluginInstall: async (args: string[]) => {
    installCalls.push([...args]);
    if (installFailureForSource && args.includes(installFailureForSource)) {
      throw new Error(`install failed for ${installFailureForSource}`);
    }
  },
}));

mock.module(searchPeersPath, () => ({
  searchPeers: async (query: string, opts: { peer?: string }) => {
    peerSearchCalls.push({ query, opts });
    return peerSearchResult;
  },
}));

const handler = (await import("../../src/commands/plugins/plugin/index.ts?plugin-index-coverage")).default;

function baseRegistry(): RegistryManifest {
  return {
    schemaVersion: 1,
    updated: "2026-05-17T00:00:00.000Z",
    plugins: {
      alpha: alphaEntry,
      beta: {
        version: "2.0.0",
        source: "https://registry.example/beta.tgz",
        sha256: null,
        summary: "Beta helpers",
        author: "Maw Test",
        license: "Apache-2.0",
        addedAt: "2026-05-02",
      },
    },
    packages: {
      suite: { summary: "Two plugin suite", plugins: ["alpha", "beta"] },
    },
  };
}

async function run(args: string[], writer?: (...args: unknown[]) => void) {
  return handler({ source: "cli", args, writer } as any);
}

beforeEach(() => {
  registryUrlValue = "https://registry.example/registry.json";
  registryManifest = baseRegistry();
  resolvedSource = { source: "https://registry.example/resolved.tgz" };
  installCalls = [];
  installFailureForSource = null;
  peerSearchResult = { hits: [], queried: 0, responded: 0, elapsedMs: 0, errors: [] };
  peerSearchCalls = [];
});

describe("maw plugin index command", () => {
  test("returns usage when no subcommand is provided", async () => {
    const result = await run([]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw plugin");
    expect(result.output).toContain("registry");
  });

  test("returns an unknown-subcommand error with usage", async () => {
    const result = await run(["missing"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown plugin subcommand: missing");
    expect(result.error).toContain("usage: maw plugin");
  });

  test("registry subcommand prints registry URL, updated timestamp, and plugin count", async () => {
    const result = await run(["registry"]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registry: https://registry.example/registry.json");
    expect(result.output).toContain("updated:  2026-05-17T00:00:00.000Z");
    expect(result.output).toContain("plugins:  2");
  });

  test("info subcommand prints all registry metadata for a plugin", async () => {
    const result = await run(["info", "alpha"]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("alpha@1.2.3");
    expect(result.output).toContain("summary:  Alpha tools");
    expect(result.output).toContain("source:   https://registry.example/alpha.tgz");
    expect(result.output).toContain("sha256:   sha256:alpha");
    expect(result.output).toContain("homepage: https://example.test/alpha");
  });

  test("info subcommand returns a clear error when plugin is absent", async () => {
    const result = await run(["info", "absent"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("plugin 'absent' not in registry");
  });

  test("search subcommand prints sorted registry matches", async () => {
    const result = await run(["search", "tools"]);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("alpha@1.2.3  Alpha tools");
  });

  test("search subcommand combines registry and peer results when peers flag is set", async () => {
    peerSearchResult = {
      hits: [
        {
          name: "peer-alpha",
          version: "0.5.0",
          summary: "Peer hit",
          peerName: "node-a",
          peerNode: "node-b",
          peerUrl: "https://node-a.example",
          identityMismatch: true,
        },
      ],
      queried: 2,
      responded: 1,
      elapsedMs: 1250,
      errors: [
        { peerName: "offline", peerUrl: "https://offline.example", reason: "timeout", detail: "2000ms" },
      ],
    };

    const result = await run(["search", "alpha", "--peers"]);

    expect(result.ok).toBe(true);
    expect(peerSearchCalls).toEqual([{ query: "alpha", opts: { peer: undefined } }]);
    expect(result.output).toContain("registry:\n  alpha@1.2.3  Alpha tools");
    expect(result.output).toContain("peers (2 queried, 1 responded in 1.3s):");
    expect(result.output).toContain("peer-alpha@0.5.0  Peer hit  @node-a(node-b)");
    expect(result.output).toContain("[identity-mismatch]");
    expect(result.output).toContain("! offline: timeout (2000ms)");
  });

  test("search subcommand requires a query", async () => {
    const result = await run(["search", "--peers"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw plugin search <query>");
  });

  test("install subcommand expands registry package names into plugin installs", async () => {
    const result = await run(["install", "suite", "--pin"]);

    expect(result.ok).toBe(true);
    expect(installCalls).toEqual([
      ["https://registry.example/resolved.tgz", "--pin"],
      ["https://registry.example/resolved.tgz", "--pin"],
    ]);
    expect(result.output).toContain("installing package 'suite': 2 plugins — Two plugin suite");
    expect(result.output).toContain("package 'suite': 2/2 installed");
  });

  test("install subcommand reports partial package install failures", async () => {
    installFailureForSource = "https://registry.example/resolved.tgz";

    const result = await run(["install", "suite"]);

    expect(result.ok).toBe(false);
    expect(installCalls).toHaveLength(2);
    expect(result.error).toContain("! alpha: install failed for https://registry.example/resolved.tgz");
    expect(result.error).toContain("package 'suite': 0/2 installed (2 failed)");
  });

  test("install subcommand explains unknown plain registry names", async () => {
    resolvedSource = null;

    const result = await run(["install", "unknown"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("plugin 'unknown' not in registry");
    expect(result.error).toContain("packages available: suite");
    expect(installCalls).toEqual([]);
  });

  test("install subcommand passes direct URLs through without registry resolution", async () => {
    const result = await run(["install", "https://plugins.example/direct.tgz", "--pin"]);

    expect(result.ok).toBe(true);
    expect(installCalls).toEqual([["https://plugins.example/direct.tgz", "--pin"]]);
  });

  test("writer receives command output instead of buffered output", async () => {
    const lines: string[] = [];
    const result = await run(["registry"], (...args: unknown[]) => lines.push(args.map(String).join(" ")));

    expect(result.ok).toBe(true);
    expect(result.output).toBeUndefined();
    expect(lines).toEqual([
      "registry: https://registry.example/registry.json",
      "updated:  2026-05-17T00:00:00.000Z",
      "plugins:  2",
    ]);
  });
});
