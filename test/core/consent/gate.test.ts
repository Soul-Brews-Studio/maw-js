/**
 * Consent gate tests (#644 Phase 1).
 *
 * The gate is decision-only — it doesn't print or exit. We assert on the
 * GateDecision shape and on the side-effects to the local stores.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { maybeGateConsent } from "../../../src/core/consent/gate";
import { recordTrust, listPending } from "../../../src/core/consent";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "consent-gate-"));
  process.env.CONSENT_TRUST_FILE = join(workdir, "trust.json");
  process.env.CONSENT_PENDING_DIR = join(workdir, "consent-pending");
});

afterEach(() => {
  delete process.env.CONSENT_TRUST_FILE;
  delete process.env.CONSENT_PENDING_DIR;
  rmSync(workdir, { recursive: true, force: true });
});

describe("maybeGateConsent", () => {
  it("allows local target", async () => {
    const r = await maybeGateConsent({
      myNode: "neo",
      resolved: { type: "local", target: "01-mawjs:0" },
      query: "mawjs", message: "hi",
    });
    expect(r.allow).toBe(true);
  });

  it("allows self-node target", async () => {
    const r = await maybeGateConsent({
      myNode: "neo",
      resolved: { type: "self-node", target: "01-mawjs:0" },
      query: "neo:mawjs", message: "hi",
    });
    expect(r.allow).toBe(true);
  });

  it("allows when resolved is null or error (defer to existing diagnostics)", async () => {
    const a = await maybeGateConsent({ myNode: "neo", resolved: null, query: "x", message: "y" });
    expect(a.allow).toBe(true);
    const b = await maybeGateConsent({
      myNode: "neo",
      resolved: { type: "error", reason: "x", detail: "y" },
      query: "x", message: "y",
    });
    expect(b.allow).toBe(true);
  });

  it("allows peer when already trusted", async () => {
    recordTrust({
      from: "neo", to: "white", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const r = await maybeGateConsent({
      myNode: "neo",
      resolved: { type: "peer", peerUrl: "http://white:3456", target: "homekeeper", node: "white" },
      query: "white:homekeeper", message: "hi",
    });
    expect(r.allow).toBe(true);
  });

  it("denies and surfaces PIN when peer not trusted (peer reachable)", async () => {
    // Stub global fetch so requestConsent's POST succeeds
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      const r = await maybeGateConsent({
        myNode: "neo",
        resolved: { type: "peer", peerUrl: "http://white:3456", target: "homekeeper", node: "white" },
        query: "white:homekeeper", message: "hello",
      });
      expect(r.allow).toBe(false);
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("consent required");
      expect(r.message).toContain("white");
      // PIN format appears in message
      expect(r.message).toMatch(/[A-Z2-9]{6}/);
      // Pending entry mirrored locally
      expect(listPending().length).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("denies with error message when peer unreachable", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const r = await maybeGateConsent({
        myNode: "neo",
        resolved: { type: "peer", peerUrl: "http://down:3456", target: "x", node: "down" },
        query: "down:x", message: "hi",
      });
      expect(r.allow).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.message).toContain("consent request failed");
      expect(r.message).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("allows when peer node is missing (defers to existing error path)", async () => {
    const r = await maybeGateConsent({
      myNode: "neo",
      resolved: { type: "peer", peerUrl: "http://x:3456", target: "x", node: "" },
      query: "x", message: "y",
    });
    expect(r.allow).toBe(true);
  });
});
