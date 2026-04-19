/**
 * runTeamInvite — unit tests (#644 Phase 2).
 *
 * Mirrors the gate-plugin-install.test.ts shape: decision-only, no CLI
 * side-effects. Network I/O is stubbed via globalThis.fetch override.
 *
 * Peer/node lookup is injected (peerLookup + myNode opts) so tests don't
 * depend on maw.config.json — `loadConfig()` is module-cached and its
 * backing path is evaluated at import time, making env-based overrides
 * brittle in a test process.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  runTeamInvite,
  recordInvitee,
  type NamedPeer,
} from "../../src/commands/plugins/team/team-invite";
import { recordTrust, listPending, listTrust } from "../../src/core/consent";

let testDir: string;
let originalCwd: string;
let consentDir: string;
let originalConsent: string | undefined;
let originalTrust: string | undefined;
let originalPending: string | undefined;

const WHITE_PEER: NamedPeer = { name: "white-peer", url: "http://white:3456", node: "white" };
const stubLookup = (want: NamedPeer | null) => (_name: string): NamedPeer | null => want;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = mkdtempSync(join(tmpdir(), "team-invite-"));
  // Oracle-root markers so resolvePsi() walks to testDir/ψ
  mkdirSync(join(testDir, "ψ/memory/mailbox/teams/test-team"), { recursive: true });
  writeFileSync(join(testDir, "CLAUDE.md"), "# test oracle\n");
  writeFileSync(
    join(testDir, "ψ/memory/mailbox/teams/test-team/manifest.json"),
    JSON.stringify({ name: "test-team", members: [], description: "test" }),
  );
  process.chdir(testDir);

  // Isolate consent stores per-test
  consentDir = mkdtempSync(join(tmpdir(), "team-invite-consent-"));
  originalTrust = process.env.CONSENT_TRUST_FILE;
  originalPending = process.env.CONSENT_PENDING_DIR;
  process.env.CONSENT_TRUST_FILE = join(consentDir, "trust.json");
  process.env.CONSENT_PENDING_DIR = join(consentDir, "pending");

  // Default OFF — each test opts in explicitly where needed
  originalConsent = process.env.MAW_CONSENT;
  delete process.env.MAW_CONSENT;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConsent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = originalConsent;
  if (originalTrust === undefined) delete process.env.CONSENT_TRUST_FILE;
  else process.env.CONSENT_TRUST_FILE = originalTrust;
  if (originalPending === undefined) delete process.env.CONSENT_PENDING_DIR;
  else process.env.CONSENT_PENDING_DIR = originalPending;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(consentDir, { recursive: true, force: true }); } catch { /* ok */ }
});

function readManifest(): any {
  const path = join(testDir, "ψ/memory/mailbox/teams/test-team/manifest.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("runTeamInvite — consent OFF (default)", () => {
  test("records invitee directly when MAW_CONSENT is not set", async () => {
    const r = await runTeamInvite("test-team", "white-peer", {
      peerLookup: stubLookup(WHITE_PEER),
      myNode: "neo",
    });
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.invitees).toHaveLength(1);
    expect(m.invitees[0]).toMatchObject({
      name: "white-peer",
      url: "http://white:3456",
      node: "white",
      scope: "member",
    });
    // No consent round-trip at all
    expect(listPending()).toHaveLength(0);
  });

  test("honors --scope override", async () => {
    const r = await runTeamInvite("test-team", "white-peer", {
      peerLookup: stubLookup(WHITE_PEER),
      myNode: "neo",
      scope: "observer",
    });
    expect(r.ok).toBe(true);
    expect(readManifest().invitees[0].scope).toBe("observer");
  });

  test("fails with exit 1 when team does not exist", async () => {
    const r = await runTeamInvite("ghost", "white-peer", {
      peerLookup: stubLookup(WHITE_PEER),
      myNode: "neo",
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("team 'ghost' not found");
  });

  test("fails with exit 1 when peer not in namedPeers", async () => {
    const r = await runTeamInvite("test-team", "ghost-peer", {
      peerLookup: stubLookup(null),
      myNode: "neo",
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("unknown peer 'ghost-peer'");
    expect(r.message).toContain("namedPeers");
  });
});

describe("runTeamInvite — consent ON (MAW_CONSENT=1)", () => {
  beforeEach(() => { process.env.MAW_CONSENT = "1"; });

  test("allows when peer is already trusted for team-invite", async () => {
    recordTrust({
      from: "neo", to: "white", action: "team-invite",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const r = await runTeamInvite("test-team", "white-peer", {
      peerLookup: stubLookup(WHITE_PEER),
      myNode: "neo",
    });
    expect(r.ok).toBe(true);
    expect(readManifest().invitees).toHaveLength(1);
    // No new pending request — trust entry bypassed the network
    expect(listPending()).toHaveLength(0);
  });

  test("does NOT cross trust scopes — a 'hey' trust entry does not allow team-invite", async () => {
    recordTrust({
      from: "neo", to: "white", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      const r = await runTeamInvite("test-team", "white-peer", {
        peerLookup: stubLookup(WHITE_PEER),
        myNode: "neo",
      });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(2);
      // Manifest untouched — invite NOT recorded pre-approval
      expect(readManifest().invitees).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("denies and surfaces PIN + team context when peer reachable", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      const r = await runTeamInvite("test-team", "white-peer", {
        peerLookup: stubLookup(WHITE_PEER),
        myNode: "neo",
        scope: "observer",
        lead: "neo",
      });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("consent required");
      expect(r.message).toContain("team-invite");
      // Team context
      expect(r.message).toContain("test-team");
      expect(r.message).toContain("lead: neo");
      // Peer context — nickname + node + URL
      expect(r.message).toContain("white-peer");
      expect(r.message).toContain("white");
      expect(r.message).toContain("http://white:3456");
      // Scope surfaced
      expect(r.message).toContain("observer");
      // PIN format — 6 chars from A-Z2-9
      expect(r.message).toMatch(/[A-Z2-9]{6}/);
      // Pending mirror written + action scoped correctly
      expect(listPending()).toHaveLength(1);
      expect(listPending()[0]!.action).toBe("team-invite");
      // Manifest untouched
      expect(readManifest().invitees).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("returns exitCode 1 with error message when peer unreachable", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const r = await runTeamInvite("test-team", "white-peer", {
        peerLookup: stubLookup(WHITE_PEER),
        myNode: "neo",
      });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.message).toContain("consent request failed");
      expect(r.message).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("falls back to peerName for trust key when peerNode is absent", async () => {
    const legacyPeer: NamedPeer = { name: "legacy-peer", url: "http://legacy:3456" };
    recordTrust({
      from: "neo", to: "legacy-peer", action: "team-invite",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    const r = await runTeamInvite("test-team", "legacy-peer", {
      peerLookup: stubLookup(legacyPeer),
      myNode: "neo",
    });
    expect(r.ok).toBe(true);
    expect(readManifest().invitees[0].name).toBe("legacy-peer");
    expect(listTrust()).toHaveLength(1);
  });
});

describe("recordInvitee", () => {
  test("is idempotent — re-invite updates instead of duplicating", () => {
    recordInvitee("test-team", WHITE_PEER, "member");
    recordInvitee("test-team", WHITE_PEER, "observer");
    const m = readManifest();
    expect(m.invitees).toHaveLength(1);
    expect(m.invitees[0].scope).toBe("observer");
  });

  test("throws when team manifest missing", () => {
    expect(() => recordInvitee("ghost", WHITE_PEER, "member")).toThrow(/not found/);
  });

  test("preserves existing manifest fields (members, description)", () => {
    recordInvitee("test-team", WHITE_PEER, "member");
    const m = readManifest();
    expect(m.name).toBe("test-team");
    expect(m.description).toBe("test");
    expect(m.members).toEqual([]);
  });
});

describe("runTeamInvite — re-run after approval flow", () => {
  test("denied → approve locally → re-run succeeds and records invite", async () => {
    process.env.MAW_CONSENT = "1";
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: true, status: 201 } as Response);
    try {
      // First run — consent required
      const r1 = await runTeamInvite("test-team", "white-peer", {
        peerLookup: stubLookup(WHITE_PEER),
        myNode: "neo",
      });
      expect(r1.ok).toBe(false);
      expect(r1.exitCode).toBe(2);
      // No invitee recorded yet
      expect(readManifest().invitees).toBeUndefined();

      // Simulate approval by writing a trust entry (the `maw consent approve`
      // path does this on the target side — on re-run, the initiator sees
      // their OWN trust entry, not the target's. For this test, we record
      // the initiator-side trust directly to model "post-approval re-run".
      recordTrust({
        from: "neo", to: "white", action: "team-invite",
        approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
      });

      // Second run — trusted, no network, invite recorded
      const r2 = await runTeamInvite("test-team", "white-peer", {
        peerLookup: stubLookup(WHITE_PEER),
        myNode: "neo",
      });
      expect(r2.ok).toBe(true);
      const m = readManifest();
      expect(m.invitees).toHaveLength(1);
      expect(m.invitees[0].name).toBe("white-peer");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
