import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ZenohApi } from "../../src/vendor/mpr-plugins/zenoh-scout/impl";

const root = join(import.meta.dir, "../..");

let appliedPlans: unknown[] = [];
let seedCalls: Array<{ target: string; parent: string }> = [];
let peerCopies: string[] = [];
let fleetRegistrations: unknown[] = [];
let prCalls: Array<{ target: string; stem: string }> = [];
let logs: string[] = [];
let tempRoot = "";
let profileMode: "missing" | "throw" = "missing";

const originalLog = console.log;

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-exec"), () => ({
  applyFromRepoInjection: async (plan: unknown, opts: unknown) => {
    appliedPlans.push({ plan, opts });
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-git"), () => ({
  cloneShallow: async () => {
    throw new Error("clone not expected in this isolated test");
  },
  cleanupClone: () => {},
  branchCommitPushPR: async (target: string, stem: string, log: (message: string) => void) => {
    prCalls.push({ target, stem });
    log(`prepared review for ${stem}`);
    return `https://example.invalid/${stem}`;
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-fleet"), () => ({
  registerFleetEntry: (opts: unknown) => {
    fleetRegistrations.push(opts);
    return { created: true, file: "/tmp/fleet/01-sprout.json" };
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo-seed"), () => ({
  seedFromParent: (target: string, parent: string, log: (message: string) => void) => {
    seedCalls.push({ target, parent });
    log(`seeded memory from ${parent}`);
  },
  copyPeersSnapshot: (target: string, log: (message: string) => void) => {
    peerCopies.push(target);
    log("copied peer snapshot");
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/profile/impl"), () => ({
  cmdList: () => [],
  cmdCurrent: () => "default",
  formatList: () => "",
  cmdUse: (name: string) => ({ name }),
  cmdShow: () => {
    if (profileMode === "throw") throw new Error("profile store unavailable");
    return null;
  },
}));

const { cmdBudFromRepo } = await import("../../src/vendor/mpr-plugins/bud/from-repo.ts?coverage-vendor-dream-bud-bud-profile-zenoh");
const { default: profileHandler } = await import("../../src/vendor/mpr-plugins/profile/index.ts?coverage-vendor-dream-bud-bud-profile-zenoh");
const {
  decodeSegment,
  discoveryKey,
  readZenohScoutConfig,
  runZenohScout,
} = await import("../../src/vendor/mpr-plugins/zenoh-scout/impl.ts?coverage-vendor-dream-bud-bud-profile-zenoh");

class FakeConfig {
  constructor(public locator: string, public timeoutMs?: number) {}
}

class FakeKeyExpr {
  constructor(public key: string) {}
  toString() {
    return this.key;
  }
}

function makeRepo(name = "repo") {
  const repo = join(tempRoot, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-coverage-vendor-bud-"));
  appliedPlans = [];
  seedCalls = [];
  peerCopies = [];
  fleetRegistrations = [];
  prCalls = [];
  logs = [];
  profileMode = "missing";
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("targeted vendor coverage for bud/profile/zenoh", () => {
  test("bud local execution invokes seed, peer, and review callbacks on the success path", async () => {
    const repo = makeRepo("local");

    await cmdBudFromRepo({
      target: repo,
      stem: "sprout",
      isUrl: false,
      pr: true,
      dryRun: false,
      from: "parent",
      seed: true,
      syncPeers: true,
    } as never);

    expect(appliedPlans).toHaveLength(1);
    expect(seedCalls).toEqual([{ target: repo, parent: "parent" }]);
    expect(peerCopies).toEqual([repo]);
    expect(fleetRegistrations).toEqual([{ stem: "sprout", target: repo, parent: "parent" }]);
    expect(prCalls).toEqual([{ target: repo, stem: "sprout" }]);
    const rendered = logs.join("\n");
    expect(rendered).toContain("seeded memory from parent");
    expect(rendered).toContain("copied peer snapshot");
    expect(rendered).toContain("prepared review for sprout");
    expect(rendered).toContain("fleet entry registered");
  });

  test("profile show reports missing profiles and storage exceptions as structured failures", async () => {
    let result = await profileHandler({ source: "cli", args: ["show", "ghost"] } as never);

    expect(result).toEqual({
      ok: false,
      error: 'profile "ghost" not found',
      output: "",
    });

    profileMode = "throw";
    result = await profileHandler({ source: "cli", args: ["show", "ghost"] } as never);

    expect(result).toEqual({
      ok: false,
      error: "profile store unavailable",
      output: "",
    });
  });

  test("zenoh scout open fallback advertises, receives a peer, and cleans up token/session", async () => {
    const local = readZenohScoutConfig({
      node: "m5",
      oracle: "codex",
      port: 3456,
      zenoh: { scout: { enabled: true, locator: "ws://router:10000" } },
    } as never);
    const peer = readZenohScoutConfig({
      node: "white",
      oracle: "pulse",
      port: 4567,
      zenoh: { scout: { enabled: true } },
    } as never);
    const peerKey = discoveryKey(peer);
    const calls: string[] = [];
    const session = {
      liveliness() {
        return {
          async declareToken(key: FakeKeyExpr) {
            calls.push(`declare:${key.toString()}`);
            return {
              async undeclare() {
                calls.push("undeclare");
              },
            };
          },
          async get(key: FakeKeyExpr, opts: Record<string, unknown>) {
            calls.push(`get:${key.toString()}:${opts.timeout}`);
            return (async function* () {
              yield { keyexpr: () => peerKey };
            })();
          },
        };
      },
      async close() {
        calls.push("close");
      },
    };
    const api: ZenohApi = {
      Config: FakeConfig,
      KeyExpr: FakeKeyExpr,
      open: async (config: unknown) => {
        expect(config).toBeInstanceOf(FakeConfig);
        calls.push("open");
        return session as never;
      },
    };

    const result = await runZenohScout(local, {
      importZenoh: async () => api,
      now: () => new Date("2026-05-18T02:03:04.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.peers.map((p) => `${p.node}:${p.oracle}:${p.host}`)).toEqual(["white:pulse:white:4567"]);
    expect(calls).toEqual([
      "open",
      `declare:${discoveryKey(local)}`,
      "get:maw/discovery/v1/**:750",
      "undeclare",
      "close",
    ]);
  });

  test("zenoh segment decoding returns null when Buffer rejects malformed input", () => {
    const originalFrom = Buffer.from;
    try {
      (Buffer as unknown as { from: typeof Buffer.from }).from = (() => {
        throw new Error("bad base64url");
      }) as typeof Buffer.from;

      expect(decodeSegment("not-decodable")).toBeNull();
    } finally {
      (Buffer as unknown as { from: typeof Buffer.from }).from = originalFrom;
    }
  });
});
