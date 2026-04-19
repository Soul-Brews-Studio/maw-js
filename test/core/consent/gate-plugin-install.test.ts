/**
 * maybeGatePluginInstall — unit tests (#644 Phase 3).
 *
 * Gate is decision-only: it doesn't print or exit. We assert the decision
 * shape and on side-effects to the local stores (pending mirror + trust).
 *
 * Network I/O is stubbed via globalThis.fetch override — same pattern as
 * the Phase 1 gate.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  maybeGatePluginInstall,
  shortSha,
} from "../../../src/core/consent/gate-plugin-install";
import { recordTrust, listPending } from "../../../src/core/consent";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "consent-pi-gate-"));
  process.env.CONSENT_TRUST_FILE = join(workdir, "trust.json");
  process.env.CONSENT_PENDING_DIR = join(workdir, "consent-pending");
});

afterEach(() => {
  delete process.env.CONSENT_TRUST_FILE;
  delete process.env.CONSENT_PENDING_DIR;
  rmSync(workdir, { recursive: true, force: true });
});

function ctx(over: Partial<Parameters<typeof maybeGatePluginInstall>[0]> = {}) {
  return {
    myNode: "neo",
    peerName: "white-peer",
    peerNode: "white",
    peerUrl: "http://white:3456",
    pluginName: "ping",
    pluginVersion: "1.0.0",
    pluginSha256: "sha256:9a34beefdeadcafe00112233",
    ...over,
  };
}

describe("shortSha", () => {
  it("strips sha256: prefix and returns first 8 hex chars", () => {
    expect(shortSha("sha256:9a34beefdeadcafe")).toBe("9a34beef");
  });
  it("handles bare hex without prefix", () => {
    expect(shortSha("9a34beefdeadcafe")).toBe("9a34beef");
  });
  it("returns <no sha> for null/undefined/empty", () => {
    expect(shortSha(null)).toBe("<no sha>");
    expect(shortSha(undefined)).toBe("<no sha>");
    expect(shortSha("")).toBe("<no sha>");
  });
});

describe("maybeGatePluginInstall", () => {
  it("allows when peer is already trusted for plugin-install", async () => {
    recordTrust({
      from: "neo", to: "white", action: "plugin-install",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const r = await maybeGatePluginInstall(ctx());
    expect(r.allow).toBe(true);
    // No pending mirror should have been created.
    expect(listPending().length).toBe(0);
  });

  it("does NOT cross trust scopes — a 'hey' trust entry does not allow plugin-install", async () => {
    recordTrust({
      from: "neo", to: "white", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      const r = await maybeGatePluginInstall(ctx());
      expect(r.allow).toBe(false);
      expect(r.exitCode).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("denies and surfaces PIN + plugin context when peer reachable", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      const r = await maybeGatePluginInstall(ctx());
      expect(r.allow).toBe(false);
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("consent required");
      expect(r.message).toContain("plugin-install");
      // Peer context shown
      expect(r.message).toContain("white-peer");
      expect(r.message).toContain("white");
      expect(r.message).toContain("http://white:3456");
      // Plugin context shown
      expect(r.message).toContain("ping@1.0.0");
      // Short sha — first 8 hex chars of the sha256
      expect(r.message).toContain("9a34beef");
      // PIN format (6 chars, A-Z2-9)
      expect(r.message).toMatch(/[A-Z2-9]{6}/);
      // Pending mirror was written
      expect(listPending().length).toBe(1);
      expect(listPending()[0]!.action).toBe("plugin-install");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns exitCode 1 with error message when peer unreachable", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const r = await maybeGatePluginInstall(ctx());
      expect(r.allow).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.message).toContain("consent request failed");
      expect(r.message).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("falls back to peerName for trust key when peerNode is absent", async () => {
    // Record trust under peerName (the fallback identifier).
    recordTrust({
      from: "neo", to: "white-peer", action: "plugin-install",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const r = await maybeGatePluginInstall(ctx({ peerNode: undefined }));
    expect(r.allow).toBe(true);
  });

  it("handles a missing sha256 gracefully (shows <no sha>)", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      const r = await maybeGatePluginInstall(ctx({ pluginSha256: null }));
      expect(r.allow).toBe(false);
      expect(r.message).toContain("<no sha>");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
