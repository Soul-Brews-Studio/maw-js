import { describe, expect, test } from "bun:test";
import { cmdFederationStatus, cmdFederationStatusVerify } from "../src/commands/shared/federation";
import type { Session } from "../src/core/runtime/find-window";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function captureLog() {
  const lines: string[] = [];
  return {
    log: (message?: unknown) => lines.push(String(message ?? "")),
    text: () => stripAnsi(lines.join("\n")),
  };
}

function session(name: string, windows: number): Session {
  return {
    name,
    windows: Array.from({ length: windows }, (_, index) => ({ index, name: `w${index}`, active: index === 0 })),
  };
}

describe("cmdFederationStatus", () => {
  test("renders local-only status with the no-peers hint and fail-soft local count", async () => {
    const logs = captureLog();

    await cmdFederationStatus({
      getPeers: () => [],
      loadConfig: () => ({ namedPeers: [] }),
      listSessions: async () => { throw new Error("tmux unavailable"); },
      getFederationStatus: async () => ({
        localUrl: "http://localhost:3456",
        peers: [],
        totalPeers: 0,
        reachablePeers: 0,
        clockHealth: { clockUtc: "2026-05-17T00:00:00.000Z", timezone: "UTC", uptimeSeconds: 1 },
      }),
      log: logs.log,
    });

    const out = logs.text();
    expect(out).toContain("Federation Status  1 node (1 local + 0 peers)");
    expect(out).toContain("local  online  0 agents");
    expect(out).toContain("No peers configured");
    expect(out).toContain("namedPeers");
  });

  test("renders named, host, localhost, throwing, and unreachable peers", async () => {
    const logs = captureLog();
    const fetched: string[] = [];

    await cmdFederationStatus({
      getPeers: () => [
        "http://named:3456",
        "http://localhost:4567",
        "http://other-host:3456",
        "http://throw-host:3456",
        "not a url",
      ],
      loadConfig: () => ({
        node: "m5",
        namedPeers: [{ name: "named-peer", url: "http://named:3456" }],
      }),
      listSessions: async () => [session("local-a", 1), session("local-b", 2)],
      getFederationStatus: async () => ({
        localUrl: "http://localhost:3456",
        peers: [
          { url: "http://named:3456", reachable: true, latency: 7 },
          { url: "http://localhost:4567", reachable: true, latency: 8 },
          { url: "http://other-host:3456", reachable: true, latency: 9 },
          { url: "http://throw-host:3456", reachable: true, latency: 10 },
          { url: "not a url", reachable: false },
        ],
        totalPeers: 5,
        reachablePeers: 4,
        clockHealth: { clockUtc: "2026-05-17T00:00:00.000Z", timezone: "UTC", uptimeSeconds: 1 },
      }),
      curlFetch: async (url: string) => {
        fetched.push(url);
        if (url.includes("named")) return { ok: true, status: 200, data: [session("r1", 2), session("r2", 1)] } as never;
        if (url.includes("localhost")) return { ok: true, status: 200, data: [session("solo", 1)] } as never;
        if (url.includes("other-host")) return { ok: false, status: 503 } as never;
        throw new Error("network down");
      },
      log: logs.log,
    });

    const out = logs.text();
    expect(fetched).toEqual([
      "http://named:3456/api/sessions",
      "http://localhost:4567/api/sessions",
      "http://other-host:3456/api/sessions",
      "http://throw-host:3456/api/sessions",
    ]);
    expect(out).toContain("Federation Status  6 nodes (1 local + 5 peers)");
    expect(out).toContain("m5 (local)  online  3 agents");
    expect(out).toContain("named-peer  reachable  7ms · 3 agents");
    expect(out).toContain("localhost:4567  reachable  8ms · 1 agent");
    expect(out).toContain("other-host:3456  reachable  9ms · 0 agents");
    expect(out).toContain("throw-host:3456  reachable  10ms · 0 agents");
    expect(out).toContain("not a url  unreachable");
    expect(out).toContain("5/6 reachable");
  });
});

describe("cmdFederationStatusVerify", () => {
  test("returns ok for zero pair symmetric status", async () => {
    const logs = captureLog();

    const result = await cmdFederationStatusVerify({
      loadConfig: () => ({ namedPeers: [] }),
      getFederationStatusSymmetric: async () => ({ totalPairs: 0, healthyPairs: 0, localNode: "m5", pairs: [] }),
      log: logs.log,
    });

    expect(result).toEqual({ ok: true });
    expect(logs.text()).toContain("Federation Status — Symmetric  0 pairs · local: m5");
    expect(logs.text()).toContain("No peers configured");
  });

  test("renders every symmetric pair state and returns non-ok on unhealthy pairs", async () => {
    const logs = captureLog();

    const result = await cmdFederationStatusVerify({
      loadConfig: () => ({ namedPeers: [{ name: "named-peer", url: "http://named:3456" }] }),
      getFederationStatusSymmetric: async () => ({
        totalPairs: 6,
        healthyPairs: 1,
        localNode: "m5",
        pairs: [
          { url: "http://named:3456", pair: "healthy" },
          { url: "http://half:3456", pair: "half-up", reason: "missing reverse route" },
          { url: "http://half-no-reason:3456", pair: "half-up" },
          { url: "http://down:3456", pair: "down", reason: "forward unreachable" },
          { url: "http://down-no-reason:3456", pair: "down" },
          { url: "bad url", pair: "unknown" },
        ],
      }),
      log: logs.log,
    });

    const out = logs.text();
    expect(result).toEqual({ ok: false });
    expect(out).toContain("Federation Status — Symmetric  6 pairs · local: m5");
    expect(out).toContain("named-peer  healthy  (A↔B)");
    expect(out).toContain("half:3456  half-up  (A→B OK, B→A failed: missing reverse route)");
    expect(out).toContain("half-no-reason:3456  half-up  (A→B OK, B→A failed)");
    expect(out).toContain("down:3456  down  (forward unreachable)");
    expect(out).toContain("down-no-reason:3456  down  (both directions failing)");
    expect(out).toContain("bad url  unknown  (reverse check inconclusive)");
    expect(out).toContain("1/6 pairs healthy");
  });
});
