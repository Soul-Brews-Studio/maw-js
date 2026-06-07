import { beforeEach, describe, expect, mock, test } from "bun:test";

type PeerResult = { ok: boolean; error?: string; hint?: string; candidates?: any[]; accepted?: any[]; skipped?: any[]; message?: string; alias?: string; node?: string; url?: string };
let addResult: any;
let probeResult: any;
let peerStore: any;
let discoveryResponse: PeerResult;
let acceptedResponse: PeerResult;
let forgetOutcome: "cleared" | "no-pubkey" | "not-found" = "cleared";

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/impl"), () => ({
  cmdAdd: async () => addResult,
  cmdProbe: async () => probeResult,
  cmdList: () => [],
  formatList: () => "no peers",
  cmdInfo: () => null,
  cmdRemove: () => false,
  cmdForget: async () => forgetOutcome,
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/store"), () => ({ loadPeers: () => peerStore }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/probe"), () => ({
  formatProbeError: (err: any, url: string, alias: string) => `formatted ${err.code} ${alias} ${url}`,
  PROBE_EXIT_CODES: { DNS: 3, TIMEOUT: 5 },
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/probe-all"), () => ({
  cmdProbeAll: async () => ({ rows: [{ alias: "a" }], failCount: 0, worstExitCode: 0 }),
  formatProbeAll: () => "probe-all ok",
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/discovered"), () => ({
  fetchDiscoveries: async () => discoveryResponse,
  formatDiscoveries: () => "discoveries formatted",
  acceptPeer: async () => acceptedResponse,
}));

const handler = (await import("../../src/vendor/mpr-plugins/peers/index.ts?coverage-100b-peers-index")).default;

function cli(args: string[]) {
  return { source: "cli", args } as any;
}

beforeEach(() => {
  addResult = { overwrote: false, peer: { node: null }, probeError: undefined };
  probeResult = { ok: true, node: "node-a" };
  peerStore = { peers: { alpha: { url: "https://alpha.example", node: "alpha" } } };
  discoveryResponse = { ok: true };
  acceptedResponse = { ok: true, alias: "alpha", node: "alpha", url: "https://alpha.example" };
  forgetOutcome = "cleared";
});

describe("coverage-100b vendor-b peers dispatcher gaps", () => {
  test("list --discovered prints json payload and accept --all prints empty message", async () => {
    discoveryResponse = { ok: true, accepted: [], skipped: [], message: "none" };
    const listed = await handler(cli(["list", "--discovered", "--json"]));
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain('"ok": true');

    acceptedResponse = { ok: true, accepted: [], skipped: [], message: "no candidates" };
    const accepted = await handler(cli(["accept", "--all"]));
    expect(accepted.ok).toBe(true);
    expect(accepted.output).toContain("no candidates");
  });

  test("accept error with candidates and list discovery fetch error surface output", async () => {
    acceptedResponse = { ok: false, error: "ambiguous", hint: "be specific", candidates: [{ zid: "abcdef1234567890", node: "n", host: "h" }] };
    const accepted = await handler(cli(["accept", "abc"]));
    expect(accepted.ok).toBe(false);
    expect(accepted.output).toContain("candidates:");
    expect(accepted.output).toContain("abcdef123456… n (h)");

    discoveryResponse = { ok: false, error: "daemon down", hint: "start serve" };
    const listed = await handler(cli(["ls", "--discovered"]));
    expect(listed.ok).toBe(false);
    expect(listed.output).toContain("daemon down");
  });

  test("forget no-pubkey/not-found and catch block return stable dispatcher results", async () => {
    forgetOutcome = "no-pubkey";
    await expect(handler(cli(["forget", "legacy"]))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("no cached pubkey") });

    forgetOutcome = "not-found";
    await expect(handler(cli(["forget", "ghost"]))).resolves.toMatchObject({ ok: false, error: 'peer "ghost" not found' });

    addResult = { overwrote: false, peer: { node: null }, probeError: { code: "DNS" } };
    const add = await handler(cli(["add", "a", "https://a.example"]));
    expect(add.ok).toBe(false);
    expect(add.exitCode).toBe(3);
    expect(add.output).toContain("formatted DNS a https://a.example");
  });
});
