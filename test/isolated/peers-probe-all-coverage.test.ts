/**
 * Isolated coverage for src/vendor/mpr-plugins/peers/probe-all.ts.
 *
 * Isolated because this test mocks the peer store + probe seams with
 * process-global mock.module before dynamically importing probe-all.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type LastError = {
  code: "DNS" | "REFUSED" | "TIMEOUT" | "TLS" | "HTTP_4XX" | "HTTP_5XX" | "BAD_BODY" | "UNKNOWN";
  message: string;
  at: string;
};

type PeerRecord = {
  url: string;
  node: string | null;
  addedAt: string;
  lastSeen: string | null;
  lastError?: LastError;
};

type PeersFile = { version: 1; peers: Record<string, PeerRecord> };

type ProbeResult = { node: string | null; error?: LastError };

const originalDateNow = Date.now;
let peers: Record<string, PeerRecord> = {};
let mutateCalls = 0;
let probeCalls: Array<{ url: string; timeoutMs: number }> = [];
let probeResults: Record<string, ProbeResult> = {};
let deleteAliasBeforeMutate: string | null = null;

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/store.ts"), () => ({
  loadPeers: (): PeersFile => ({ version: 1, peers: { ...peers } }),
  mutatePeers: (mutator: (data: PeersFile) => void): PeersFile => {
    mutateCalls += 1;
    if (deleteAliasBeforeMutate) delete peers[deleteAliasBeforeMutate];
    const data = { version: 1 as const, peers };
    mutator(data);
    return data;
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/peers/probe.ts"), () => ({
  PROBE_EXIT_CODES: {
    DNS: 3,
    REFUSED: 4,
    TIMEOUT: 5,
    HTTP_4XX: 6,
    HTTP_5XX: 6,
    TLS: 2,
    BAD_BODY: 2,
    UNKNOWN: 2,
  },
  probePeer: async (url: string, timeoutMs: number): Promise<ProbeResult> => {
    probeCalls.push({ url, timeoutMs });
    return probeResults[url] ?? { node: null };
  },
}));

const { cmdProbeAll, formatProbeAll } = await import("../../src/vendor/mpr-plugins/peers/probe-all");

function error(code: LastError["code"], message = code): LastError {
  return { code, message, at: "2026-05-18T00:00:00.000Z" };
}

function peer(url: string, fields: Partial<PeerRecord> = {}): PeerRecord {
  return {
    url,
    node: null,
    addedAt: "2026-05-17T00:00:00.000Z",
    lastSeen: null,
    ...fields,
  };
}

beforeEach(() => {
  peers = {};
  mutateCalls = 0;
  probeCalls = [];
  probeResults = {};
  deleteAliasBeforeMutate = null;
});

afterEach(() => {
  Date.now = originalDateNow;
});

describe("cmdProbeAll", () => {
  test("probes peers in alias order and batch-mutates successes and failures", async () => {
    const priorFailure = error("REFUSED", "old refusal");
    const dnsFailure = error("DNS", "host not found");
    const timeoutFailure = error("TIMEOUT", "too slow");
    peers = {
      zebra: peer("http://zebra.local", { node: "old-zebra", lastSeen: "2026-05-01T00:00:00.000Z", lastError: priorFailure }),
      alpha: peer("http://alpha.local", { node: "old-alpha", lastSeen: "2026-05-02T00:00:00.000Z" }),
      beta: peer("http://beta.local", { node: "old-beta", lastSeen: null }),
    };
    probeResults = {
      "http://alpha.local": { node: "new-alpha" },
      "http://beta.local": { node: null, error: dnsFailure },
      "http://zebra.local": { node: null, error: timeoutFailure },
    };
    let now = 1_700_000_000_000;
    Date.now = () => (now += 7);

    const result = await cmdProbeAll(321);

    expect(probeCalls).toEqual([
      { url: "http://alpha.local", timeoutMs: 321 },
      { url: "http://beta.local", timeoutMs: 321 },
      { url: "http://zebra.local", timeoutMs: 321 },
    ]);
    expect(mutateCalls).toBe(1);
    expect(result.okCount).toBe(1);
    expect(result.failCount).toBe(2);
    expect(result.worstExitCode).toBe(5);
    expect(result.rows.map((row) => row.alias)).toEqual(["alpha", "beta", "zebra"]);
    expect(result.rows[0]).toMatchObject({ alias: "alpha", node: "new-alpha", ok: true });
    expect(result.rows[0].lastSeen).toBeString();
    expect(result.rows[0].lastSeen).not.toBe("2026-05-02T00:00:00.000Z");
    expect(result.rows[1]).toMatchObject({ alias: "beta", node: "old-beta", ok: false, error: dnsFailure });
    expect(result.rows[2]).toMatchObject({ alias: "zebra", node: "old-zebra", ok: false, error: timeoutFailure });

    expect(peers.alpha.node).toBe("new-alpha");
    expect(peers.alpha.lastSeen).toBe(result.rows[0].lastSeen);
    expect(peers.alpha.lastError).toBeUndefined();
    expect(peers.beta.lastError).toBe(dnsFailure);
    expect(peers.zebra.lastError).toBe(timeoutFailure);
  });

  test("does not mutate an empty store", async () => {
    const result = await cmdProbeAll();

    expect(result).toEqual({ rows: [], okCount: 0, failCount: 0, worstExitCode: 0 });
    expect(probeCalls).toHaveLength(0);
    expect(mutateCalls).toBe(0);
  });

  test("skips peers removed between load and mutate while still returning settled rows", async () => {
    const refused = error("REFUSED", "closed port");
    peers = {
      gone: peer("http://gone.local"),
      ok: peer("http://ok.local"),
    };
    probeResults = {
      "http://gone.local": { node: null, error: refused },
      "http://ok.local": { node: "ok-node" },
    };
    deleteAliasBeforeMutate = "gone";

    const result = await cmdProbeAll();

    expect(result.rows.map((row) => row.alias)).toEqual(["gone", "ok"]);
    expect(peers.gone).toBeUndefined();
    expect(peers.ok.node).toBe("ok-node");
    expect(mutateCalls).toBe(1);
  });
});

describe("formatProbeAll", () => {
  test("renders no peers for empty results", () => {
    expect(formatProbeAll({ rows: [], okCount: 0, failCount: 0, worstExitCode: 0 })).toBe("no peers");
  });

  test("renders success and failure rows with stripped ANSI width calculations", () => {
    const output = formatProbeAll({
      okCount: 1,
      failCount: 1,
      worstExitCode: 6,
      rows: [
        { alias: "alpha", url: "http://alpha.local", node: "alpha-node", lastSeen: "2026-05-18T00:00:00.000Z", ok: true, ms: 12 },
        { alias: "beta", url: "http://beta.local", node: null, lastSeen: null, ok: false, ms: 5, error: error("HTTP_5XX", "boom") },
      ],
    });

    expect(output).toContain("alias");
    expect(output).toContain("alpha-node");
    expect(output).toContain("\x1b[32m✓\x1b[0m ok (12ms)");
    expect(output).toContain("\x1b[31m✗\x1b[0m HTTP_5XX");
    expect(output).toContain("1/2 ok, 1 failed");
  });
});
