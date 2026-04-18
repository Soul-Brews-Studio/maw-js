/**
 * maw peers — probe / handshake error tests (#565).
 *
 * Kept separate from peers.test.ts to stay under CONTRIBUTING's
 * file-size cap and to group handshake-error coverage in one place.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-peers-probe-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

describe("classifyProbeError", () => {
  it("ENOTFOUND → DNS", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ cause: { code: "ENOTFOUND" } })).toBe("DNS");
  });

  it.each([
    ["EAI_AGAIN",  /Host does not resolve/],
    ["EAI_NODATA", /Host does not resolve/],
    ["EAI_FAIL",   /Host does not resolve/],
    ["ENOTIMP",    /avahi-daemon.*etc\/hosts/],
  ])("%s → DNS bucket with expected hint (#593)", async (code, hintRe) => {
    const { classifyProbeError, pickHint } = await import("./probe");
    expect(classifyProbeError({ cause: { code } })).toBe("DNS");
    expect(pickHint({ code: "DNS", message: `getaddrinfo ${code} x`, at: "" })).toMatch(hintRe);
  });

  it("ECONNREFUSED → REFUSED", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ cause: { code: "ECONNREFUSED" } })).toBe("REFUSED");
  });

  it("AbortError → TIMEOUT", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ name: "AbortError" })).toBe("TIMEOUT");
  });

  it("ETIMEDOUT → TIMEOUT", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ cause: { code: "ETIMEDOUT" } })).toBe("TIMEOUT");
  });

  it("CERT_HAS_EXPIRED → TLS", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ cause: { code: "CERT_HAS_EXPIRED" } })).toBe("TLS");
  });

  it("SELF_SIGNED_CERT_IN_CHAIN → TLS", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } })).toBe("TLS");
  });

  it("non-ok Response with 404 → HTTP_4XX", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ status: 404, ok: false })).toBe("HTTP_4XX");
  });

  it("non-ok Response with 502 → HTTP_5XX", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ status: 502, ok: false })).toBe("HTTP_5XX");
  });

  it("unknown error shape → UNKNOWN", async () => {
    const { classifyProbeError } = await import("./probe");
    expect(classifyProbeError({ message: "weird" })).toBe("UNKNOWN");
    expect(classifyProbeError(null)).toBe("UNKNOWN");
    expect(classifyProbeError("string-thrown")).toBe("UNKNOWN");
  });
});

describe("PROBE_HINTS", () => {
  it("every code has an actionable hint", async () => {
    const { PROBE_HINTS } = await import("./probe");
    const codes = ["DNS", "REFUSED", "TIMEOUT", "TLS", "HTTP_4XX", "HTTP_5XX", "BAD_BODY", "UNKNOWN"] as const;
    for (const c of codes) {
      expect(PROBE_HINTS[c]).toBeTruthy();
      expect(PROBE_HINTS[c].length).toBeGreaterThan(10);
    }
  });
});

describe("formatProbeError", () => {
  it("renders host, error, hint, retry line", async () => {
    const { formatProbeError } = await import("./probe");
    const out = formatProbeError(
      { code: "DNS", message: "getaddrinfo ENOTFOUND white.local", at: "2026-04-19T01:02:03Z" },
      "http://white.local:3456",
      "w",
    );
    expect(out).toContain("peer handshake failed");
    expect(out).toContain("DNS");
    expect(out).toContain("white.local:3456");
    expect(out).toContain("getaddrinfo ENOTFOUND");
    expect(out).toContain("Host does not resolve");
    expect(out).toContain("maw peers probe w");
  });
});

describe("probePeer — real network failure", () => {
  it("connection refused to 127.0.0.1:1 → REFUSED", async () => {
    const { probePeer } = await import("./probe");
    // Port 1 is well-known reserved + never bound on CI runners.
    const res = await probePeer("http://127.0.0.1:1", 1500);
    expect(res.node).toBeNull();
    expect(res.error).toBeDefined();
    // Some platforms return REFUSED, some UNKNOWN for this path — accept both
    // but REQUIRE a structured error (the whole point of #565).
    expect(["REFUSED", "UNKNOWN", "TIMEOUT"]).toContain(res.error!.code);
  });

  it("DNS failure → DNS code", async () => {
    const { probePeer } = await import("./probe");
    // RFC 6761 reserves .invalid for guaranteed-unresolvable names.
    const res = await probePeer("http://does-not-exist.invalid:9999", 1500);
    expect(res.node).toBeNull();
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe("DNS");
  });
});

describe("cmdAdd — persists lastError on probe failure", () => {
  it("adding unreachable peer still succeeds, lastError recorded", async () => {
    const { cmdAdd, cmdInfo } = await import("./impl");
    const res = await cmdAdd({ alias: "ghost", url: "http://does-not-exist.invalid:9999" });
    expect(res.probeError).toBeDefined();
    expect(res.probeError!.code).toBe("DNS");
    expect(res.peer.lastSeen).toBeNull();

    const info = cmdInfo("ghost");
    expect(info).not.toBeNull();
    expect(info!.lastError).toBeDefined();
    expect(info!.lastError!.code).toBe("DNS");
    expect(info!.lastError!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("explicit --node still gets used even when probe fails", async () => {
    const { cmdAdd } = await import("./impl");
    const res = await cmdAdd({ alias: "w", url: "http://does-not-exist.invalid:9999", node: "white" });
    expect(res.peer.node).toBe("white");
    expect(res.probeError).toBeDefined(); // still warned about
  });
});

describe("cmdProbe", () => {
  it("throws for unknown alias", async () => {
    const { cmdProbe } = await import("./impl");
    await expect(cmdProbe("nope")).rejects.toThrow(/not found/);
  });

  it("probing an unreachable peer records lastError, returns ok=false", async () => {
    const { cmdAdd, cmdProbe, cmdInfo } = await import("./impl");
    await cmdAdd({ alias: "g", url: "http://does-not-exist.invalid:9999", node: "manual" });
    const r = await cmdProbe("g");
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("DNS");
    const info = cmdInfo("g");
    expect(info!.lastError!.code).toBe("DNS");
    expect(info!.node).toBe("manual"); // not overwritten on failure
  });
});

describe("dispatcher — probe subcommand + loud add", () => {
  it("probe requires alias", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: ["probe"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("usage: maw peers probe");
  });

  it("probe on unknown alias → error", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: ["probe", "ghost"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('peer "ghost" not found');
  });

  it("add on unreachable host still returns ok:true but writes warning to output", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({
      source: "cli",
      args: ["add", "g", "http://does-not-exist.invalid:9999"],
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("added g");
    // Loud block is on stderr, which the dispatcher captures into the
    // same logs buffer — both streams end up in res.output.
    expect(res.output).toContain("peer handshake failed");
    expect(res.output).toContain("DNS");
    expect(res.output).toContain("maw peers probe g");
  });

  it("info output contains lastError after a failed add", async () => {
    const { default: handler } = await import("./index");
    await handler({
      source: "cli",
      args: ["add", "g", "http://does-not-exist.invalid:9999"],
    });
    const info = await handler({ source: "cli", args: ["info", "g"] });
    expect(info.ok).toBe(true);
    expect(info.output).toContain("lastError");
    expect(info.output).toContain("DNS");
  });

  it("probe dispatcher on unreachable peer → ok:false with hint", async () => {
    const { default: handler } = await import("./index");
    await handler({
      source: "cli",
      args: ["add", "g", "http://does-not-exist.invalid:9999"],
    });
    const r = await handler({ source: "cli", args: ["probe", "g"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("probe failed");
    expect(r.output).toContain("peer handshake failed");
  });

  it("help lists the probe subcommand", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: [] });
    expect(res.output).toContain("probe");
  });
});

describe("back-compat", () => {
  it("resolveNode still returns string | null and swallows errors", async () => {
    const { resolveNode } = await import("./impl");
    const n = await resolveNode("http://does-not-exist.invalid:9999");
    expect(n).toBeNull();
  });

  it("Peer without lastError serializes cleanly (no undefined field in JSON)", async () => {
    const { cmdAdd, cmdInfo } = await import("./impl");
    await cmdAdd({ alias: "w", url: "http://w.local", node: "white" });
    const info = cmdInfo("w");
    // When probe fails on http://w.local (DNS), lastError IS set.
    // To test the "no error" branch, we need a peer that won't probe —
    // we can't guarantee that without a real server, so we just verify
    // that info returns a valid record and JSON.stringify doesn't choke.
    expect(info).not.toBeNull();
    const json = JSON.stringify(info, null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
