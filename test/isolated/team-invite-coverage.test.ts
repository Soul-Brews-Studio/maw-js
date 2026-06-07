import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

interface MockConfig {
  node?: string;
  namedPeers?: Array<{ name: string; url: string; node?: string }>;
}

interface ConsentRequest {
  from: string;
  to: string;
  action: string;
  summary: string;
  peerUrl: string;
}

type ConsentResult =
  | { ok: true; requestId: string; pin: string; expiresAt: string }
  | { ok: false; error: string; requestId?: string };

let config: MockConfig = {};
let trusted = false;
let consentResult: ConsentResult = {
  ok: true,
  requestId: "req-default",
  pin: "123456",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
let trustCalls: Array<[string, string, string]> = [];
let consentRequests: ConsentRequest[] = [];

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

mock.module("maw-js/core/consent", () => ({
  isTrusted: (from: string, to: string, action: string) => {
    trustCalls.push([from, to, action]);
    return trusted;
  },
  requestConsent: async (request: ConsentRequest) => {
    consentRequests.push(request);
    return consentResult;
  },
}));

const { cmdTeamInvite, recordInvitee, runTeamInvite } = await import(
  "../../src/vendor/mpr-plugins/team/team-invite"
);

const original = {
  cwd: process.cwd(),
  consent: process.env.MAW_CONSENT,
  log: console.log,
  error: console.error,
  exit: process.exit,
};

let root = "";
let logs: string[] = [];
let errors: string[] = [];
let exitCodes: Array<number | undefined> = [];

function teamManifestPath(teamName = "alpha") {
  return join(root, "ψ", "memory", "mailbox", "teams", teamName, "manifest.json");
}

function writeManifest(teamName = "alpha", manifest: Record<string, unknown> = { name: teamName }) {
  const path = teamManifestPath(teamName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function readManifest(teamName = "alpha") {
  return JSON.parse(readFileSync(teamManifestPath(teamName), "utf-8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-team-invite-coverage-"));
  mkdirSync(join(root, "ψ"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "test oracle root\n");
  process.chdir(root);

  config = { node: "local-node", namedPeers: [] };
  trusted = false;
  consentResult = {
    ok: true,
    requestId: "req-default",
    pin: "123456",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  trustCalls = [];
  consentRequests = [];
  logs = [];
  errors = [];
  exitCodes = [];

  delete process.env.MAW_CONSENT;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCodes.push(code);
    throw new Error(`process.exit:${code}`);
  };
});

afterEach(() => {
  process.chdir(original.cwd);
  if (original.consent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = original.consent;
  console.log = original.log;
  console.error = original.error;
  process.exit = original.exit;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vendor team invite coverage", () => {
  test("returns a team-not-found decision before resolving peers", async () => {
    const peerLookup = mock(() => ({ name: "peer", url: "http://peer" }));

    const decision = await runTeamInvite("missing", "peer", { peerLookup });

    expect(decision).toEqual({
      ok: false,
      exitCode: 1,
      message: "\x1b[31m✗\x1b[0m team 'missing' not found — run: maw team create missing",
    });
    expect(peerLookup).not.toHaveBeenCalled();
    expect(trustCalls).toEqual([]);
    expect(consentRequests).toEqual([]);
  });

  test("uses default namedPeers lookup and reports unknown peers", async () => {
    writeManifest("alpha", { name: "alpha" });
    config = { node: "lead-node", namedPeers: [{ name: "known", url: "https://known.example" }] };

    const decision = await runTeamInvite("alpha", "stranger");

    expect(decision.ok).toBe(false);
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain("unknown peer 'stranger'");
    expect(decision.message).toContain("hint: add stranger to maw.config.json namedPeers");
    expect(readManifest("alpha")).toEqual({ name: "alpha" });
  });

  test("records a default-scope invite without consent when MAW_CONSENT is not enabled", async () => {
    writeManifest("alpha", { name: "alpha", members: [] });
    config = {
      node: "lead-node",
      namedPeers: [{ name: "scout", url: "https://scout.example", node: "scout-node" }],
    };

    const decision = await runTeamInvite("alpha", "scout");

    expect(decision).toEqual({ ok: true });
    expect(trustCalls).toEqual([]);
    expect(consentRequests).toEqual([]);
    expect(readManifest("alpha").invitees).toEqual([
      expect.objectContaining({
        name: "scout",
        url: "https://scout.example",
        node: "scout-node",
        scope: "member",
      }),
    ]);
    expect(readManifest("alpha").invitees[0].invitedAt).toEqual(expect.any(String));
  });

  test("recordInvitee updates existing invitees and preserves unrelated entries", () => {
    writeManifest("alpha", {
      name: "alpha",
      invitees: [
        { name: "scout", url: "https://old.example", node: "old-node", scope: "member", invitedAt: "old" },
        { name: "builder", url: "https://builder.example", scope: "member", invitedAt: "keep" },
      ],
    });

    recordInvitee("alpha", { name: "scout", url: "https://new.example", node: "new-node" }, "reviewer");

    const manifest = readManifest("alpha");
    expect(manifest.invitees).toHaveLength(2);
    expect(manifest.invitees[0]).toEqual(expect.objectContaining({
      name: "scout",
      url: "https://new.example",
      node: "new-node",
      scope: "reviewer",
    }));
    expect(manifest.invitees[0].invitedAt).not.toBe("old");
    expect(manifest.invitees[1]).toEqual({
      name: "builder",
      url: "https://builder.example",
      scope: "member",
      invitedAt: "keep",
    });
  });

  test("recordInvitee surfaces missing and malformed manifest errors", () => {
    expect(() => recordInvitee("missing", { name: "peer", url: "https://peer.example" }, "member"))
      .toThrow("team 'missing' not found — run: maw team create missing");

    const malformed = teamManifestPath("broken");
    mkdirSync(dirname(malformed), { recursive: true });
    writeFileSync(malformed, "{not json");

    expect(() => recordInvitee("broken", { name: "peer", url: "https://peer.example" }, "member"))
      .toThrow(SyntaxError);
  });

  test("records immediately when team-invite trust already exists", async () => {
    writeManifest("alpha", { name: "alpha", invitees: [] });
    process.env.MAW_CONSENT = "1";
    trusted = true;

    const decision = await runTeamInvite("alpha", "scout", {
      myNode: "lead-node",
      scope: "reviewer",
      peerLookup: () => ({ name: "scout", url: "https://scout.example", node: "scout-node" }),
    });

    expect(decision).toEqual({ ok: true });
    expect(trustCalls).toEqual([["lead-node", "scout-node", "team-invite"]]);
    expect(consentRequests).toEqual([]);
    expect(readManifest("alpha").invitees[0]).toEqual(expect.objectContaining({
      name: "scout",
      url: "https://scout.example",
      node: "scout-node",
      scope: "reviewer",
    }));
  });

  test("returns request failure details and includes peer node in consent summary", async () => {
    writeManifest("alpha", { name: "alpha" });
    process.env.MAW_CONSENT = "1";
    consentResult = { ok: false, error: "peer offline", requestId: "mirror-1" };

    const decision = await runTeamInvite("alpha", "scout", {
      myNode: "lead-node",
      lead: "captain",
      scope: "observer",
      peerLookup: () => ({ name: "scout", url: "https://scout.example", node: "scout-node" }),
    });

    expect(decision.ok).toBe(false);
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain("consent request failed");
    expect(decision.message).toContain("peer offline");
    expect(decision.message).toContain("request id (local mirror): mirror-1");
    expect(consentRequests).toEqual([{
      from: "lead-node",
      to: "scout-node",
      action: "team-invite",
      peerUrl: "https://scout.example",
      summary: "team-invite: team='alpha' lead='captain' invitee='scout' (scout-node) url='https://scout.example' scope='observer'",
    }]);
    expect(readManifest("alpha")).toEqual({ name: "alpha" });
  });

  test("returns a consent-required rerun message for legacy peers without node ids", async () => {
    writeManifest("alpha", { name: "alpha" });
    process.env.MAW_CONSENT = "1";
    config = { namedPeers: [] };
    consentResult = {
      ok: true,
      requestId: "req-legacy",
      pin: "654321",
      expiresAt: "2099-02-03T04:05:06.000Z",
    };

    const decision = await runTeamInvite("alpha", "legacy", {
      peerLookup: () => ({ name: "legacy", url: "https://legacy.example" }),
    });

    expect(decision.ok).toBe(false);
    expect(decision.exitCode).toBe(2);
    expect(trustCalls).toEqual([["local", "legacy", "team-invite"]]);
    expect(consentRequests).toEqual([expect.objectContaining({
      from: "local",
      to: "legacy",
      action: "team-invite",
      peerUrl: "https://legacy.example",
      summary: "team-invite: team='alpha' lead='local' invitee='legacy' url='https://legacy.example' scope='member'",
    })]);
    expect(decision.message).toContain("consent required");
    expect(decision.message).toContain("team:   alpha  (lead: local)");
    expect(decision.message).toContain("peer:   legacy  [https://legacy.example]");
    expect(decision.message).toContain("PIN (relay OOB to legacy operator): \x1b[1m654321\x1b[0m");
    expect(decision.message).toContain("on legacy: \x1b[36mmaw consent approve req-legacy 654321\x1b[0m");
    expect(decision.message).toContain("then re-run: \x1b[36mmaw team invite alpha legacy\x1b[0m");
    expect(readManifest("alpha")).toEqual({ name: "alpha" });
  });

  test("cmdTeamInvite logs success with the default member scope", async () => {
    writeManifest("alpha", { name: "alpha" });
    config = { namedPeers: [{ name: "scout", url: "https://scout.example" }] };

    await cmdTeamInvite("alpha", "scout");

    expect(logs).toEqual(["\x1b[32m✓\x1b[0m invited 'scout' to team 'alpha' (scope: member)"]);
    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });

  test("cmdTeamInvite prints failures and exits with the decision code", async () => {
    await expect(cmdTeamInvite("missing", "scout")).rejects.toThrow("process.exit:1");

    expect(logs).toEqual([]);
    expect(errors).toEqual(["\x1b[31m✗\x1b[0m team 'missing' not found — run: maw team create missing"]);
    expect(exitCodes).toEqual([1]);
  });
});
