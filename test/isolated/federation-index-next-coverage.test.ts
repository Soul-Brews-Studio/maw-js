import { beforeEach, describe, expect, mock, test } from "bun:test";

const federationPath = import.meta.resolve("../../src/commands/shared/federation.ts");
const federationSyncPath = import.meta.resolve("../../src/commands/shared/federation-sync.ts");

let statusCalls: Array<Record<string, unknown> | undefined> = [];
let verifyCalls = 0;
let syncCalls: Array<Record<string, unknown>> = [];
let verifyResult = { ok: true };
let statusThrows: Error | null = null;

mock.module(federationPath, () => ({
  cmdFederationStatus: async (opts?: Record<string, unknown>) => {
    statusCalls.push(opts);
    if (statusThrows) throw statusThrows;
    console.log("federation status ok");
    console.error("federation status stderr");
  },
  cmdFederationStatusVerify: async () => {
    verifyCalls += 1;
    console.log("federation verify checked");
    return verifyResult;
  },
}));

mock.module(federationSyncPath, () => ({
  cmdFederationSync: async (opts: Record<string, unknown>) => {
    syncCalls.push(opts);
    console.log("federation sync ok");
  },
}));

const federationPlugin = await import(
  "../../src/commands/plugins/federation/index.ts?federation-index-next-coverage"
);
const handler = federationPlugin.default;

beforeEach(() => {
  statusCalls = [];
  verifyCalls = 0;
  syncCalls = [];
  verifyResult = { ok: true };
  statusThrows = null;
});

describe("federation plugin index dispatch", () => {
  test("exports command metadata and routes non-CLI invocations through status with writer output", async () => {
    const written: string[] = [];

    const result = await handler({
      source: "api",
      args: ["sync"],
      writer: (...parts: unknown[]) => written.push(parts.map(String).join(" ")),
    } as any);

    expect(federationPlugin.command).toEqual({
      name: "federation",
      description: "Multi-node federation status and sync.",
    });
    expect(result).toEqual({ ok: true, output: undefined });
    expect(statusCalls).toEqual([{ peerSourceMode: "both" }]);
    expect(written).toEqual(["federation status ok", "federation status stderr"]);
  });

  test("handles status verify success and unhealthy verify failures", async () => {
    let result = await handler({ source: "cli", args: ["ls", "--verify"] } as any);

    expect(result).toEqual({ ok: true, output: "federation verify checked" });
    expect(verifyCalls).toBe(1);

    verifyResult = { ok: false };
    result = await handler({ source: "cli", args: ["status", "--verify"] } as any);

    expect(result).toEqual({
      ok: false,
      error: "one or more pairs are non-healthy",
      output: "federation verify checked",
    });
    expect(verifyCalls).toBe(2);
  });

  test("passes all sync flags to the shared federation sync command", async () => {
    const result = await handler({
      source: "cli",
      args: ["sync", "--dry-run", "--check", "--prune", "--force", "--json"],
    } as any);

    expect(result).toEqual({ ok: true, output: "federation sync ok" });
    expect(syncCalls).toEqual([{
      dryRun: true,
      check: true,
      prune: true,
      force: true,
      json: true,
      peers: "config",
    }]);
  });

  test("returns usage for unknown subcommands and thrown status errors", async () => {
    let result = await handler({ source: "cli", args: ["mystery"] } as any);

    expect(result).toEqual({
      ok: false,
      error: "usage: maw federation <status|sync> [--verify|--dry-run|--check|--prune|--force|--json|--peers config|scout|both]",
    });

    statusThrows = new Error("status exploded");
    result = await handler({ source: "cli", args: ["status"] } as any);

    expect(result).toEqual({
      ok: false,
      error: "status exploded",
      output: undefined,
    });
  });

  test("accepts --peers for status/sync and rejects invalid peer source modes", async () => {
    let result = await handler({ source: "cli", args: ["--peers=scout"] } as any);

    expect(result).toEqual({ ok: true, output: "federation status ok\nfederation status stderr" });
    expect(statusCalls.at(-1)).toEqual({ peerSourceMode: "scout" });

    result = await handler({ source: "cli", args: ["sync", "--peers", "config"] } as any);

    expect(result).toEqual({ ok: true, output: "federation sync ok" });
    expect(syncCalls.at(-1)?.peers).toBe("config");

    result = await handler({ source: "cli", args: ["status", "--peers", "bogus"] } as any);

    expect(result).toEqual({ ok: false, error: "usage: --peers config|scout|both" });
  });
});
