import { beforeEach, describe, expect, mock, test } from "bun:test";

const registryFetchPath = import.meta.resolve("../../src/commands/plugins/plugin/registry-fetch");
const registryResolvePath = import.meta.resolve("../../src/commands/plugins/plugin/registry-resolve");
const installImplPath = import.meta.resolve("../../src/commands/plugins/plugin/install-impl");
const searchPeersPath = import.meta.resolve("../../src/commands/plugins/plugin/search-peers");
const initImplPath = import.meta.resolve("../../src/commands/plugins/plugin/init-impl");
const buildImplPath = import.meta.resolve("../../src/commands/plugins/plugin/build-impl");
const lockCliPath = import.meta.resolve("../../src/commands/plugins/plugin/lock-cli");

let calls: Array<{ name: string; args: string[] }> = [];
let registry: any;
let resolved: { source: string } | null = null;
let installError: unknown = null;
let peerResult: any;

mock.module(registryFetchPath, () => ({
  registryUrl: () => "https://registry.example/registry.json",
  getRegistry: async () => registry,
}));
mock.module(registryResolvePath, () => ({
  resolvePluginSource: () => resolved,
}));
mock.module(installImplPath, () => ({
  cmdPluginInstall: async (args: string[]) => {
    calls.push({ name: "install", args });
    if (installError) throw installError;
  },
}));
mock.module(searchPeersPath, () => ({
  searchPeers: async (query: string, opts: { peer?: string }) => {
    calls.push({ name: "searchPeers", args: [query, opts.peer ?? ""] });
    return peerResult;
  },
}));
mock.module(initImplPath, () => ({
  cmdPluginInit: async (args: string[]) => calls.push({ name: "init", args }),
}));
mock.module(buildImplPath, () => ({
  cmdPluginBuild: async (args: string[]) => calls.push({ name: "build", args }),
  cmdPluginDev: async (args: string[]) => calls.push({ name: "dev", args }),
}));
mock.module(lockCliPath, () => ({
  cmdPluginPin: async (args: string[]) => calls.push({ name: "pin", args }),
  cmdPluginUnpin: async (args: string[]) => calls.push({ name: "unpin", args }),
}));

const handler = (await import("../../src/commands/plugins/plugin/index.ts?plugin-index-more-coverage")).default;

async function run(args: string[]) {
  return handler({ source: "cli", args } as any);
}

beforeEach(() => {
  calls = [];
  resolved = { source: "https://registry.example/alpha.tgz" };
  installError = null;
  registry = {
    schemaVersion: 1,
    updated: "now",
    plugins: {
      alpha: { version: "1.0.0", source: "url", sha256: null, summary: "Alpha", author: "A", license: "MIT", addedAt: "today" },
    },
  };
  peerResult = { hits: [], queried: 1, responded: 1, elapsedMs: 40, errors: [] };
});

describe("plugin index more coverage", () => {
  test("routes init, build, dev, pin, and unpin subcommands", async () => {
    for (const args of [
      ["init", "demo", "--ts"],
      ["build", ".", "--types"],
      ["dev", ".", "--types"],
      ["pin", "alpha", "alpha.tgz"],
      ["unpin", "alpha"],
    ]) {
      const result = await run(args);
      expect(result.ok).toBe(true);
    }

    expect(calls).toEqual([
      { name: "init", args: ["demo", "--ts"] },
      { name: "build", args: [".", "--types"] },
      { name: "dev", args: [".", "--types"] },
      { name: "pin", args: ["alpha", "alpha.tgz"] },
      { name: "unpin", args: ["alpha"] },
    ]);
  });

  test("search reports no registry hits and peer-only empty results", async () => {
    let result = await run(["search", "zzz"]);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('no plugins match "zzz"');

    result = await run(["search", "zzz", "--peers-only"]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("peers (1 queried, 1 responded in 0.0s):");
    expect(result.output).toContain("  (no hits)");
    expect(result.output).not.toContain("registry:");
  });

  test("search --peer requires a value and scopes peer search", async () => {
    let result = await run(["search", "alpha", "--peer"]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("--peer requires a name");

    peerResult = {
      hits: [{ name: "alpha", version: "1", peerUrl: "http://peer", summary: undefined }],
      queried: 1,
      responded: 1,
      elapsedMs: 100,
      errors: [{ peerUrl: "http://slow", reason: "timeout" }],
    };
    result = await run(["search", "alpha", "--peer", "node-a"]);
    expect(result.ok).toBe(true);
    expect(calls).toContainEqual({ name: "searchPeers", args: ["alpha", "node-a"] });
    expect(result.output).toContain("alpha@1    @http://peer");
    expect(result.output).toContain("! http://slow: timeout");
    expect(result.output).not.toContain("registry:");
  });

  test("info requires a plugin name", async () => {
    const result = await run(["info"]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("usage: maw plugin info <name>");
  });

  test("install handles plain packages without packages map and Cannot find module fallback", async () => {
    resolved = null;
    let result = await run(["install", "missing"]);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("packages available");

    installError = new Error("Cannot find module './install-impl'");
    result = await run(["install", "./local-plugin"]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("plugin install: not yet implemented");
  });

  test("API source ignores args and returns usage", async () => {
    const result = await handler({ source: "api", args: ["registry"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw plugin");
  });
});
