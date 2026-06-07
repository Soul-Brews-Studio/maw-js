/**
 * Focused branch coverage for cmdPluginInstall in install-impl.ts.
 *
 * The install handlers, source detector, peer resolver, and consent gate are
 * mocked so this exercises install-impl dispatch/error flow only: no network,
 * no tar extraction, and no writes outside process-local mocks.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sourceDetectPath = import.meta.resolve("../../src/commands/plugins/plugin/install-source-detect");
const extractionPath = import.meta.resolve("../../src/commands/plugins/plugin/install-extraction");
const manifestHelpersPath = import.meta.resolve("../../src/commands/plugins/plugin/install-manifest-helpers");
const handlersPath = import.meta.resolve("../../src/commands/plugins/plugin/install-handlers");
const peerResolverPath = import.meta.resolve("../../src/commands/plugins/plugin/install-peer-resolver");
const consentGatePath = import.meta.resolve("../../src/core/consent/gate-plugin-install");
const configPath = import.meta.resolve("../../src/config");

type InstallMode =
  | { kind: "dir"; src: string }
  | { kind: "tarball"; src: string }
  | { kind: "monorepo"; src: string; subpath: string; tag: string }
  | { kind: "github"; src: string; owner: string; repo: string; subpath?: string; ref?: string }
  | { kind: "peer"; src: string; name: string; peer: string }
  | { kind: "url"; src: string };

type HandlerCall = { fn: string; args: unknown[] };
type ResolvedPeer = {
  peerName: string;
  peerNode?: string;
  peerUrl: string;
  version: string;
  peerSha256?: string;
  downloadUrl: string;
};

let plannedMode: InstallMode = { kind: "url", src: "https://plugins.example/default.tgz" };
let ensureRootCalls = 0;
let detectCalls: string[] = [];
let handlerCalls: HandlerCall[] = [];
let resolveCalls: Array<[string, string]> = [];
let consentCalls: unknown[] = [];
let consentDecision: { allow: boolean; message?: string; exitCode?: number } = { allow: true };
let resolvedPeer: ResolvedPeer = {
  peerName: "white",
  peerNode: "node-white",
  peerUrl: "http://white.internal:2700",
  version: "2.0.0",
  peerSha256: "sha256:abcdef1234567890",
  downloadUrl: "http://white.internal:2700/api/plugin/download/ping",
};
let configNode: string | undefined = "codex-test-node";
let stdout: string[] = [];
let stderr: string[] = [];
let exitCode: number | undefined;

const originalEnv = {
  consent: process.env.MAW_CONSENT,
};
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

function record(fn: string, args: unknown[]): void {
  handlerCalls.push({ fn, args });
}

mock.module(sourceDetectPath, () => ({
  installRoot: () => "/mock/maw/plugins",
  detectMode: (src: string) => {
    detectCalls.push(src);
    return plannedMode;
  },
  parsePeerSpec: () => null,
  parseMonorepoRef: () => null,
  parseGithubRef: () => null,
  ensureInstallRoot: () => {
    ensureRootCalls += 1;
  },
  removeExisting: () => undefined,
}));

mock.module(extractionPath, () => ({
  extractTarball: () => ({ ok: true }),
  downloadTarball: async () => ({ ok: false, error: "download should stay mocked" }),
  verifyArtifactHash: () => ({ ok: true }),
}));

mock.module(manifestHelpersPath, () => ({
  readManifest: () => null,
  shortHash: (value: string) => value.slice(0, 12),
  printInstallSuccess: () => undefined,
  findMonorepoPluginRoot: () => null,
}));

mock.module(handlersPath, () => ({
  installFromDir: async (...args: unknown[]) => record("dir", args),
  installFromTarball: async (...args: unknown[]) => record("tarball", args),
  installFromUrl: async (...args: unknown[]) => record("url", args),
  installFromMonorepo: async (...args: unknown[]) => record("monorepo", args),
  installFromGithub: async (...args: unknown[]) => record("github", args),
  ensurePluginMawJsLink: () => undefined,
  monorepoTarballUrl: () => "https://registry.example/archive.tgz",
  monorepoRepoSlug: () => "Soul-Brews-Studio/maw-plugin-registry",
  githubBaseUrl: () => "https://github.com",
}));

mock.module(peerResolverPath, () => ({
  resolvePeerInstall: async (name: string, peer: string) => {
    resolveCalls.push([name, peer]);
    return resolvedPeer;
  },
}));

mock.module(consentGatePath, () => ({
  maybeGatePluginInstall: async (input: unknown) => {
    consentCalls.push(input);
    return consentDecision;
  },
}));

mock.module(configPath, () => ({
  loadConfig: () => ({ node: configNode }),
}));

const { cmdPluginInstall } = await import(
  "../../src/commands/plugins/plugin/install-impl.ts?plugin-install-impl-more-coverage"
);

beforeEach(() => {
  plannedMode = { kind: "url", src: "https://plugins.example/default.tgz" };
  ensureRootCalls = 0;
  detectCalls = [];
  handlerCalls = [];
  resolveCalls = [];
  consentCalls = [];
  consentDecision = { allow: true };
  resolvedPeer = {
    peerName: "white",
    peerNode: "node-white",
    peerUrl: "http://white.internal:2700",
    version: "2.0.0",
    peerSha256: "sha256:abcdef1234567890",
    downloadUrl: "http://white.internal:2700/api/plugin/download/ping",
  };
  configNode = "codex-test-node";
  stdout = [];
  stderr = [];
  exitCode = undefined;
  delete process.env.MAW_CONSENT;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  (process as any).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__plugin_install_impl_test_exit__:${exitCode}`);
  };
});

afterEach(() => {
  if (originalEnv.consent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = originalEnv.consent;
  console.log = originalLog;
  console.error = originalError;
  (process as any).exit = originalExit;
});

describe("cmdPluginInstall validation", () => {
  test("throws usage for empty and help invocations before install-root setup", async () => {
    await expect(cmdPluginInstall([])).rejects.toThrow(/usage: maw plugin install/);
    await expect(cmdPluginInstall(["--help"])).rejects.toThrow(/usage: maw plugin install/);
    await expect(cmdPluginInstall(["-h"])).rejects.toThrow(/usage: maw plugin install/);

    expect(ensureRootCalls).toBe(0);
    expect(detectCalls).toEqual([]);
    expect(handlerCalls).toEqual([]);
  });

  test("rejects unknown --category values before handler dispatch", async () => {
    plannedMode = { kind: "dir", src: "/tmp/plugin" };

    await expect(cmdPluginInstall(["/tmp/plugin", "--category", "premium"])).rejects.toThrow(
      /--category must be one of: core, standard, extra \(got "premium"\)/,
    );

    expect(ensureRootCalls).toBe(1);
    expect(detectCalls).toEqual(["/tmp/plugin"]);
    expect(handlerCalls).toEqual([]);
  });
});

describe("cmdPluginInstall source dispatch", () => {
  test("passes force and category weight to directory installs, ignoring --pin", async () => {
    plannedMode = { kind: "dir", src: "/tmp/dev-plugin" };

    await cmdPluginInstall(["/tmp/dev-plugin", "--force", "--pin", "--category", "core"]);

    expect(handlerCalls).toEqual([
      { fn: "dir", args: ["/tmp/dev-plugin", { force: true, weight: 5 }] },
    ]);
  });

  test("normalizes tarball source labels and forwards pin/weight options", async () => {
    plannedMode = { kind: "tarball", src: "/tmp/builds/demo-1.2.3.tgz" };

    await cmdPluginInstall(["/tmp/builds/demo-1.2.3.tgz", "--pin", "--category", "standard"]);

    expect(handlerCalls).toEqual([
      {
        fn: "tarball",
        args: [
          "/tmp/builds/demo-1.2.3.tgz",
          { source: "./demo-1.2.3.tgz", force: false, weight: 30, pin: true },
        ],
      },
    ]);
  });

  test("routes monorepo refs with subpath, tag, force, pin, and extra weight", async () => {
    plannedMode = {
      kind: "monorepo",
      src: "monorepo:plugins/bg@v1.0.0",
      subpath: "plugins/bg",
      tag: "v1.0.0",
    };

    await cmdPluginInstall(["monorepo:plugins/bg@v1.0.0", "--force", "--pin", "--category", "extra"]);

    expect(handlerCalls).toEqual([
      { fn: "monorepo", args: ["plugins/bg", "v1.0.0", { force: true, weight: 70, pin: true }] },
    ]);
  });

  test("routes GitHub refs with optional subpath/ref and install flags", async () => {
    plannedMode = {
      kind: "github",
      src: "Owner/Repo/plugins/tool@feature",
      owner: "owner",
      repo: "repo",
      subpath: "plugins/tool",
      ref: "feature",
    };

    await cmdPluginInstall(["Owner/Repo/plugins/tool@feature", "--force", "--pin", "--category", "core"]);

    expect(handlerCalls).toEqual([
      {
        fn: "github",
        args: [
          { owner: "owner", repo: "repo", subpath: "plugins/tool", ref: "feature" },
          { force: true, weight: 5, pin: true },
        ],
      },
    ]);
  });

  test("falls through to URL installs for URL-like modes", async () => {
    plannedMode = { kind: "url", src: "https://plugins.example/demo.tgz" };

    await cmdPluginInstall(["https://plugins.example/demo.tgz", "--pin", "--category", "standard"]);

    expect(handlerCalls).toEqual([
      { fn: "url", args: ["https://plugins.example/demo.tgz", { force: false, weight: 30, pin: true }] },
    ]);
  });
});

describe("cmdPluginInstall peer source flow", () => {
  test("advertises peer metadata and downloads the resolved URL without consent mode", async () => {
    plannedMode = { kind: "peer", src: "ping@white", name: "ping", peer: "white" };

    await cmdPluginInstall(["ping@white", "--pin", "--category", "extra"]);

    expect(resolveCalls).toEqual([["ping", "white"]]);
    expect(consentCalls).toEqual([]);
    expect(stdout.join("\n")).toContain("→ white (node-white) advertises: ping@2.0.0");
    expect(stdout.join("\n")).toContain("→ downloading http://white.internal:2700/api/plugin/download/ping…");
    expect(handlerCalls).toEqual([
      {
        fn: "url",
        args: [
          "http://white.internal:2700/api/plugin/download/ping",
          { force: false, weight: 70, pin: true },
        ],
      },
    ]);
  });

  test("uses local fallback node name and continues when consent allows", async () => {
    process.env.MAW_CONSENT = "1";
    configNode = undefined;
    resolvedPeer = {
      peerName: "desk",
      peerUrl: "http://desk.internal:2700",
      version: "1.0.1",
      downloadUrl: "http://desk.internal:2700/api/plugin/download/ping",
    };
    plannedMode = { kind: "peer", src: "ping@desk", name: "ping", peer: "desk" };

    await cmdPluginInstall(["ping@desk", "--force"]);

    expect(consentCalls).toEqual([
      {
        myNode: "local",
        peerName: "desk",
        peerNode: undefined,
        peerUrl: "http://desk.internal:2700",
        pluginName: "ping",
        pluginVersion: "1.0.1",
        pluginSha256: undefined,
      },
    ]);
    expect(stdout.join("\n")).toContain("→ desk advertises: ping@1.0.1");
    expect(handlerCalls).toEqual([
      {
        fn: "url",
        args: ["http://desk.internal:2700/api/plugin/download/ping", { force: true, weight: undefined, pin: false }],
      },
    ]);
  });

  test("prints consent denial and exits before downloading", async () => {
    process.env.MAW_CONSENT = "1";
    consentDecision = { allow: false, message: "operator denied install", exitCode: 23 };
    plannedMode = { kind: "peer", src: "ping@white", name: "ping", peer: "white" };

    await expect(cmdPluginInstall(["ping@white"])).rejects.toThrow(
      /__plugin_install_impl_test_exit__:23/,
    );

    expect(exitCode).toBe(23);
    expect(stderr).toEqual(["operator denied install"]);
    expect(consentCalls).toHaveLength(1);
    expect(handlerCalls).toEqual([]);
  });
});
