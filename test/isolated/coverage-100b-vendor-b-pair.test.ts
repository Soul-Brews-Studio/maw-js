import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let probeResult: any = { node: "node-a", pubkey: "pk", identity: { oracle: "o", node: "n" }, nickname: "nick" };
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
let warnings: string[] = [];

mock.module("maw-js/config", () => ({ loadConfig: () => ({ port: 4321, node: "local-node" }) }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/probe"), () => ({
  probePeer: async () => probeResult,
}));

const peersImpl = await import("../../src/vendor/mpr-plugins/pair/internal/peers-impl.ts?coverage-100b-pair-peers-impl");
const handshake = await import("../../src/vendor/mpr-plugins/pair/handshake.ts?coverage-100b-pair-handshake");
const impl = await import("../../src/vendor/mpr-plugins/pair/impl.ts?coverage-100b-pair-impl");
const handler = (await import("../../src/vendor/mpr-plugins/pair/index.ts?coverage-100b-pair-index")).default;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "maw-coverage-100b-pair-"));
  process.env.PEERS_FILE = join(root, "peers.json");
  probeResult = { node: "node-a", pubkey: "pk", identity: { oracle: "o", node: "n" }, nickname: "nick" };
  warnings = [];
  console.warn = (...parts: unknown[]) => warnings.push(parts.map(String).join(" "));
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  delete process.env.PEERS_FILE;
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
});

describe("coverage-100b vendor-b pair gaps", () => {
  test("pair cmdAdd preserves cached pubkey metadata and refreshes probe identity", async () => {
    writeFileSync(process.env.PEERS_FILE!, JSON.stringify({
      version: 1,
      peers: {
        alpha: {
          url: "https://old.example",
          node: "old",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastSeen: null,
          pubkey: "pk",
          pubkeyFirstSeen: "2026-01-02T00:00:00.000Z",
          identity: { oracle: "old", node: "old" },
        },
      },
    }));

    const result = await peersImpl.cmdAdd({ alias: "alpha", url: "https://new.example" });

    expect(result.overwrote).toBe(true);
    expect(result.peer.pubkey).toBe("pk");
    expect(result.peer.pubkeyFirstSeen).toBe("2026-01-02T00:00:00.000Z");
    expect(result.peer.identity).toEqual({ oracle: "o", node: "n" });
  });

  test("pair lock treats EPERM lock holders as alive and reports timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-coverage-100b-pair-lock-"));
    const path = join(root, "peers.json");
    writeFileSync(`${path}.lock`, "99999");
    const originalKill = process.kill;
    const originalNow = Date.now;
    let ticks = 0;
    process.kill = (() => { const err: any = new Error("denied"); err.code = "EPERM"; throw err; }) as typeof process.kill;
    Date.now = () => (ticks++ === 0 ? 1_000 : 10_000);
    const lock = await import("../../src/vendor/mpr-plugins/pair/internal/lock.ts?coverage-100b-pair-lock");

    try {
      expect(() => lock.withPeersLock(path, () => "never")).toThrow("peers lock timeout: pid 99999 still holds");
    } finally {
      process.kill = originalKill;
      Date.now = originalNow;
    }
  });

  test("handshake handles HTTP failures, network failures, and plain HTTP warnings", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 418, statusText: "teapot" })) as typeof fetch;
    await expect(handshake.postHandshake("https://peer.example", "abc", { node: "n", url: "u" })).resolves.toEqual({ ok: false, error: "teapot", status: 418 });

    globalThis.fetch = (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as typeof fetch;
    await expect(handshake.postHandshake("https://peer.example", "abc", { node: "n", url: "u" }, 1)).resolves.toMatchObject({ ok: false, error: "timeout", status: 0 });

    handshake.warnIfPlainHttp("http://192.0.2.10:5000");
    handshake.warnIfPlainHttp("not a url");
    expect(warnings.join("\n")).toContain("plain HTTP");
  });

  test("pair accept reports write failures and dispatcher catches unexpected exceptions", async () => {
    globalThis.fetch = (async () => Response.json({ ok: true, node: "Bad Alias", url: "https://peer.example", federationToken: "tok" })) as typeof fetch;
    await expect(impl.pairAccept("https://peer.example", "ABC-234")).resolves.toMatchObject({ ok: false, error: expect.stringContaining("paired but peer write failed") });

    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const result = await handler({ source: "cli", args: ["generate", "--expires", "10"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot reach local server");

    await expect(handler({ source: "cli", args: [] } as any)).resolves.toMatchObject({ ok: true, output: expect.stringContaining("maw pair generate") });
    await expect(handler({ source: "cli", args: ["generate", "--expires", "4"] } as any)).resolves.toMatchObject({ ok: false, error: "--expires must be 5..3600 seconds" });
    await expect(handler({ source: "cli", args: ["wat"] } as any)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("unexpected args") });
  });
});
