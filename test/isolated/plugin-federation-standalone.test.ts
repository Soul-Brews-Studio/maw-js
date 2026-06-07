import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const calls: Array<{ name: string; args: unknown[] }> = [];
let verifyOk = true;
let config: any = {};
let probeIdentity: any = null;
let parsePeerSourceModeImpl = (raw: string | undefined, fallback: string) => raw === "bad" ? null : (raw ?? fallback);

function at(path: string) {
  return import.meta.resolve(path);
}

mock.module(at("../../src/commands/shared/peer-sources.ts"), () => ({
  parsePeerSourceMode: (raw: string | undefined, fallback: string) => parsePeerSourceModeImpl(raw, fallback),
}));

mock.module(at("../../src/commands/shared/federation.ts"), () => ({
  cmdFederationStatus: async (opts: unknown) => {
    calls.push({ name: "status", args: [opts] });
    console.log("status ok");
  },
  cmdFederationStatusVerify: async () => {
    calls.push({ name: "verify", args: [] });
    console.log("verify ok");
    return { ok: verifyOk };
  },
}));

mock.module(at("../../src/commands/shared/federation-sync.ts"), () => ({
  cmdFederationSync: async (opts: unknown) => {
    calls.push({ name: "sync", args: [opts] });
    console.log("sync ok");
  },
}));

mock.module(at("../../src/config.ts"), () => ({
  loadConfig: () => config,
}));

mock.module(at("../../src/commands/shared/expand-plan.ts"), () => ({
  deriveExpandNode: (url: string) => new URL(url).hostname,
  computeExpandPlan: (host: string, port: number, localNode: string, peers: any[], opts: any) => {
    calls.push({ name: "plan", args: [host, port, localNode, peers, opts] });
    return {
      target: { node: opts.probeIdentity?.node ?? host, url: `http://${host}:${port}` },
      newNodeSeedConfig: { namedPeers: peers },
      reciprocalPeerUpdates: [
        { kind: "add" },
        { kind: "noop" },
        { kind: "conflict" },
      ],
      peerStoreUpdates: [{ command: "trust add" }],
      servicePlan: { kind: "systemd", manager: "systemctl", commands: ["systemctl restart maw"], warnings: ["service warning"] },
      firewallPlan: { command: "ufw allow 3456", warnings: ["firewall warning"] },
      probePlan: opts.probeIdentity ? { kind: "http", reachable: true, advertisedNode: opts.probeIdentity.node, agents: ["neo"], warnings: ["probe warning"] } : null,
      warnings: ["general warning"],
      blockingIssues: opts.probeIdentity ? ["identity mismatch"] : [],
    };
  },
}));

mock.module(at("../../src/commands/shared/expand-probe.ts"), () => ({
  fetchExpandProbeIdentity: async (url: string) => {
    calls.push({ name: "probe", args: [url] });
    return probeIdentity;
  },
}));

const { command, default: handler } = await import("../../src/commands/plugins/federation/index.ts?plugin-federation-standalone");
const cli = (args: string[]) => ({ source: "cli", args } as any);

beforeEach(() => {
  calls.length = 0;
  verifyOk = true;
  config = {
    node: "local-node",
    oracle: "local-oracle",
    namedPeers: [{ name: "white", url: "http://white.local" }],
    peers: ["http://legacy.local"],
  };
  probeIdentity = { node: "remote-advertised" };
  parsePeerSourceModeImpl = (raw: string | undefined, fallback: string) => raw === "bad" ? null : (raw ?? fallback);
});

describe("federation command plugin standalone boundary (#2290)", () => {
  test("uses SDK types and no static core/shared/config/plugin imports", () => {
    const source = readFileSync(join(root, "src/commands/plugins/federation/index.ts"), "utf8");
    expect(command).toEqual({
      name: "federation",
      description: "Multi-node federation status, sync, and expansion planning.",
    });
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+plugin\/types["']/);
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
  });

  test("status, default status, peer-source validation, and verify failure are routed", async () => {
    expect(await handler(cli([]))).toMatchObject({ ok: true, output: expect.stringContaining("status ok") });
    expect(calls.at(-1)).toEqual({ name: "status", args: [{ peerSourceMode: "both" }] });

    expect(await handler(cli(["status", "--peers", "config"]))).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual({ name: "status", args: [{ peerSourceMode: "config" }] });

    expect(await handler(cli(["status", "--peers", "bad"]))).toEqual({ ok: false, error: "usage: --peers config|scout|both" });

    verifyOk = false;
    const verified = await handler(cli(["status", "--verify"]));
    expect(verified.ok).toBe(false);
    expect(verified.error).toBe("one or more pairs are non-healthy");
    expect(calls.at(-1)?.name).toBe("verify");
  });

  test("sync maps flags and defaults peer source to config", async () => {
    const result = await handler(cli(["sync", "--dry-run", "--check", "--prune", "--force", "--json", "--peers", "scout"]));

    expect(result).toMatchObject({ ok: true, output: expect.stringContaining("sync ok") });
    expect(calls.at(-1)).toEqual({
      name: "sync",
      args: [{ dryRun: true, check: true, prune: true, force: true, json: true, peers: "scout" }],
    });

    await handler(cli(["sync"]));
    expect(calls.at(-1)).toEqual({ name: "sync", args: [{ dryRun: false, check: false, prune: false, force: false, json: false, peers: "config" }] });
  });

  test("expand validates input, supports json, probe, and read-only apply rejection", async () => {
    expect(await handler(cli(["expand"]))).toEqual({ ok: false, error: "usage: maw federation expand <new-node-host> [--port <port>] [--user <user>] [--oracle <name>] [--probe] [--json]" });
    expect(await handler(cli(["expand", "remote", "--port", "99999"]))).toEqual({ ok: false, error: "invalid --port: 99999" });
    expect(await handler(cli(["expand", "remote", "--apply"]))).toEqual({ ok: false, error: "maw federation expand is read-only in this release; --apply is not supported" });

    const json = await handler(cli(["expand", "remote", "--port", "4567", "--user", "nat", "--oracle", "neo", "--probe", "--json"]));
    expect(json.ok).toBe(true);
    const parsed = JSON.parse(json.output!);
    expect(parsed.target).toEqual({ node: "remote-advertised", url: "http://remote:4567" });
    expect(calls.map((call) => call.name)).toContain("probe");
    expect(calls.filter((call) => call.name === "plan").at(-1)?.args[4]).toMatchObject({ user: "nat", oracle: "neo", probeIdentity });
  });

  test("help, unknown subcommands, and human expand output are stable", async () => {
    const help = await handler(cli(["help"]));
    expect(help.ok).toBe(false);
    expect(help.error).toContain("usage: maw federation");

    const unknown = await handler(cli(["bogus"]));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("usage: maw federation");

    const human = await handler(cli(["expand", "remote"]));
    expect(human.ok).toBe(true);
    expect(human.output).toContain("Federation Expand Plan");
    expect(human.output).toContain("reciprocal route updates: 1 add · 1 noop · 1 conflict");
    expect(human.output).toContain("systemctl restart maw");
  });
});
