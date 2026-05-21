import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

const sdkPath = import.meta.resolve("../../src/sdk/index.ts");
const configPath = import.meta.resolve("../../src/config");

let configValue: Record<string, unknown> = {};
let statusCalls: Array<Record<string, unknown> | undefined> = [];

mock.module(configPath, () => ({
  ...mockConfigModule(() => configValue as never),
}));

mock.module(sdkPath, () => ({
  listSessions: async () => [{ name: "local", windows: [{ index: 0, name: "main", active: true }] }],
  curlFetch: async () => ({ ok: true, status: 200, data: [] }),
  getFederationStatus: async (opts?: { peers?: Array<{ name?: string; url: string }> }) => {
    statusCalls.push(opts as Record<string, unknown> | undefined);
    return {
      localUrl: "http://localhost:4567",
      localReachable: true,
      localLatency: 3,
      peers: (opts?.peers ?? []).map((peer) => ({
        url: peer.url,
        peerName: peer.name,
        reachable: true,
        latency: 5,
      })),
      totalPeers: opts?.peers?.length ?? 0,
      reachablePeers: opts?.peers?.length ?? 0,
      clockHealth: { clockUtc: "2026-05-20T00:00:00.000Z", timezone: "UTC", uptimeSeconds: 1 },
    };
  },
}));

const { cmdFederationStatus } = await import("../../src/commands/shared/federation.ts?federation-status-peer-sources");

beforeEach(() => {
  configValue = { node: "m5", port: 4567, namedPeers: [] };
  statusCalls = [];
});

describe("cmdFederationStatus peer-source resolver integration (#1808)", () => {
  test("uses resolver peers, logs scout fallback warnings, and passes ephemeral names into status", async () => {
    const lines: string[] = [];

    await cmdFederationStatus({
      resolvePeerSources: async () => ({
        mode: "both",
        warnings: ["scout unavailable (daemon_unreachable)"],
        peers: [{ name: "scout-node", url: "http://scout:3456", source: "scout" }],
      }),
      log: (message?: unknown) => lines.push(String(message ?? "")),
    });

    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.peers).toEqual([{ name: "scout-node", url: "http://scout:3456", source: "scout" }]);
    const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("scout unavailable");
    expect(out).toContain("scout-node  reachable");
    expect(out).toContain("2/2 reachable");
  });
});
