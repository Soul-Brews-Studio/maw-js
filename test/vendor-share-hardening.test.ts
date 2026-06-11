import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hashShareSecret } from "../src/vendor/mpr-plugins/share/crypto";
import {
  clearShareRegistry,
  createShare,
  verifyShare,
  type Share,
} from "../src/vendor/mpr-plugins/share/impl";
import { attach } from "../src/vendor/mpr-plugins/share/stream";
import {
  createShareViaDaemon,
  displayOriginForHost,
} from "../src/vendor/mpr-plugins/share/index";

function tamperHexDigest(hex: string): string {
  const replacement = hex.endsWith("0") ? "1" : "0";
  return `${hex.slice(0, -1)}${replacement}`;
}

describe("share hardening", () => {
  test("encrypted share verification accepts a server-visible hash proof without revealing fragment key", async () => {
    clearShareRegistry();
    const share = await createShare({ target: "session:0", auth: "encrypted", encrypted: true });
    const proof = hashShareSecret(share.token);

    expect(proof).not.toBe(share.token);
    await expect(verifyShare(share.slug, proof)).resolves.toBe(true);
    await expect(verifyShare(share.slug, tamperHexDigest(proof))).resolves.toBe(false);
  });

  test("viewer keeps encrypted key out of server-visible websocket URL", () => {
    const viewer = readFileSync(join(import.meta.dir, "../src/vendor/mpr-plugins/share/viewer.html"), "utf8");
    const server = readFileSync(join(import.meta.dir, "../src/vendor/mpr-plugins/share/index.ts"), "utf8");

    expect(viewer).toContain("const e2eKey = params.get(\"k\") || \"\";");
    expect(viewer).toContain("const wsProof = e2eKey ? await sha256Hex(e2eKey) : token;");
    expect(viewer).toContain("?${e2eKey ? \"h\" : \"t\"}=");
    expect(viewer).not.toContain("?${e2eKey ? \"k\" : \"t\"}=");
    expect(viewer).not.toContain("const wsToken = e2eKey || token");
    expect(server).not.toContain('searchParams.get("k")');
  });

  test("active stream closes itself and websocket when TTL expires", async () => {
    const share: Share = {
      target: "session:0",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 50,
      auth: "token",
    };
    const sent: Array<string | Uint8Array> = [];
    const closed: Array<[number | undefined, string | undefined]> = [];
    const pipeCalls: unknown[][] = [];
    const clearedTimers: unknown[] = [];
    const timers: Array<{ fn: () => void; ms: number; id: object }> = [];

    await attach(
      share,
      {
        send: (data: string | Uint8Array) => sent.push(data),
        close: (code?: number, reason?: string) => closed.push([code, reason]),
      } as any,
      {
        tmux: {
          capture: async () => "SNAPSHOT\n",
          pipePane: async (...args: unknown[]) => {
            pipeCalls.push(args);
          },
        },
        makeFifo: async () => undefined,
        spawnPipeReader: async () => ({
          kill: () => {},
          exited: Promise.resolve(0),
        }),
        setTimeout: ((fn: () => void, ms: number) => {
          const id = {};
          timers.push({ fn, ms, id });
          return id as any;
        }) as any,
        clearTimeout: ((id: unknown) => {
          clearedTimers.push(id);
        }) as any,
      } as any,
    );

    expect(sent).toEqual(["SNAPSHOT\n"]);
    const expiry = timers.find((timer) => timer.ms <= 50);
    expect(expiry).toBeDefined();

    expiry!.fn();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(closed).toEqual([[1008, "share expired"]]);
    expect(pipeCalls.some((call) => call[0] === "session:0" && call.length === 1)).toBe(true);
    expect(clearedTimers).toContain(expiry!.id);
  });

  test("display URL fails loud for bind-only hosts and formats IPv6 display hosts", () => {
    expect(() => displayOriginForHost("0.0.0.0", 3457)).toThrow("bind-only host");
    expect(() => displayOriginForHost("::", 3457)).toThrow("bind-only host");
    expect(() => displayOriginForHost("http://localhost", 3457)).toThrow("without protocol");
    expect(displayOriginForHost("::1", 3457)).toBe("http://[::1]:3457");
    expect(displayOriginForHost("localhost", 3457)).toBe("http://localhost:3457");
  });

  test("daemon fetch failures name the failing endpoint", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;

      await expect(createShareViaDaemon("http://127.0.0.1:3999", { target: "session:0" }))
        .rejects
        .toThrow("share daemon request failed at http://127.0.0.1:3999/api/share: ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
