import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ node: "local-node" }),
}));

import handler, { command } from "../../src/vendor/mpr-plugins/consent";
import { hashPin, writePending } from "../../src/core/consent";
import type { PendingRequest } from "../../src/core/consent";
import type { InvokeContext } from "../../src/plugin/types";

const cli = (args: string[]): InvokeContext => ({ source: "cli", args });
const api = (args: Record<string, unknown> = {}): InvokeContext => ({ source: "api", args });

describe("vendor consent plugin index coverage", () => {
  const originalTrust = process.env.CONSENT_TRUST_FILE;
  const originalPending = process.env.CONSENT_PENDING_DIR;
  let dir: string;
  let trustFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-consent-plugin-"));
    trustFile = join(dir, "trust.json");
    process.env.CONSENT_TRUST_FILE = trustFile;
    process.env.CONSENT_PENDING_DIR = join(dir, "pending");
  });

  afterEach(() => {
    if (originalTrust === undefined) delete process.env.CONSENT_TRUST_FILE;
    else process.env.CONSENT_TRUST_FILE = originalTrust;

    if (originalPending === undefined) delete process.env.CONSENT_PENDING_DIR;
    else process.env.CONSENT_PENDING_DIR = originalPending;

    rmSync(dir, { recursive: true, force: true });
  });

  const pending = (overrides: Partial<PendingRequest> = {}): PendingRequest => ({
    id: "req-1",
    from: "alpha",
    to: "local-node",
    action: "hey",
    summary: "please send a hello across the fleet with a deliberately long summary that should be truncated in list output",
    pinHash: hashPin("ABCDEF"),
    createdAt: "2026-05-18T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    status: "pending",
    ...overrides,
  });

  test("exports metadata, lists pending by default, and lists trust entries", async () => {
    expect(command).toEqual({ name: "consent", description: "PIN-consent for cross-oracle actions (#644)." });
    expect(await handler(api({ ignored: true }))).toEqual({ ok: true, output: "no pending consent requests" });

    writePending(pending());
    const listed = await handler(cli([]));
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("alpha → local-node");
    expect(listed.output).toContain("hey");
    expect(listed.output).toContain("please send a hello across the fleet with a del…");

    const emptyTrust = await handler(cli(["list-trust"]));
    expect(emptyTrust).toEqual({ ok: true, output: "no trust entries" });
  });

  test("approve and reject validate usage and surface store errors", async () => {
    expect(await handler(cli(["approve", "req-1"]))).toEqual({ ok: false, error: "usage: maw consent approve <id> <pin>" });
    expect(await handler(cli(["approve", "missing", "ABCDEF"]))).toEqual({ ok: false, error: "request not found: missing" });

    writePending(pending());
    expect(await handler(cli(["approve", "req-1", "badpin"]))).toEqual({ ok: false, error: "PIN mismatch" });

    const approved = await handler(cli(["approve", "req-1", "ABCDEF"]));
    expect(approved).toEqual({ ok: true, output: expect.stringContaining("✅ approved req-1") });
    expect(approved.output).toContain("✅ approved req-1");
    expect(approved.output).toContain("alpha → local-node:hey");

    const trustList = await handler(cli(["list-trust"]));
    expect(trustList.ok).toBe(true);
    expect(trustList.output).toContain("alpha → local-node");

    expect(await handler(cli(["reject"]))).toEqual({ ok: false, error: "usage: maw consent reject <id>" });
    expect(await handler(cli(["reject", "missing"]))).toEqual({ ok: false, error: "request not found: missing" });

    writePending(pending({ id: "req-2" }));
    expect(await handler(cli(["reject", "req-2"]))).toEqual({ ok: true, output: "✗ rejected req-2" });
    expect(await handler(cli(["reject", "req-2"]))).toEqual({ ok: false, error: "request is rejected, cannot reject" });
  });

  test("trust and untrust validate actions, default to hey, and handle missing removals", async () => {
    expect(await handler(cli(["trust"]))).toEqual({ ok: false, error: "usage: maw consent trust <peer> [action]" });
    expect(await handler(cli(["trust", "peer", "unknown"]))).toEqual({ ok: false, error: "unknown action 'unknown' — expected: hey, team-invite, plugin-install" });

    const trusted = await handler(cli(["trust", "peer"]));
    expect(trusted).toEqual({ ok: true, output: "✅ trust written: local-node → peer:hey" });
    expect(JSON.parse(readFileSync(trustFile, "utf-8")).trust["local-node→peer:hey"]).toMatchObject({ from: "local-node", to: "peer", action: "hey" });

    expect(await handler(cli(["untrust"]))).toEqual({ ok: false, error: "usage: maw consent untrust <peer> [action]" });
    expect(await handler(cli(["untrust", "peer", "weird"]))).toEqual({ ok: false, error: "unknown action 'weird'" });
    expect(await handler(cli(["untrust", "peer"]))).toEqual({ ok: true, output: "✗ removed: local-node → peer:hey" });
    expect(await handler(cli(["untrust", "peer"]))).toEqual({ ok: true, output: "(no trust entry for local-node → peer:hey)" });

    expect(await handler(cli(["trust", "peer", "plugin-install"]))).toEqual({ ok: true, output: "✅ trust written: local-node → peer:plugin-install" });
  });

  test("help aliases, unknown subcommands, and catch-all failures return structured errors", async () => {
    const help = await handler(cli(["help"]));
    expect(help.ok).toBe(true);
    expect(help.output).toContain("usage:");
    expect((await handler(cli(["help"]))).output).toContain("maw consent approve <id> <pin>");
    expect((await handler(cli(["help"]))).output).toContain("actions: hey | team-invite | plugin-install");

    const unknown = await handler(cli(["wat"]));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown subcommand: wat");
    expect(unknown.error).toContain("maw consent list-trust");

    process.env.CONSENT_TRUST_FILE = dir;
    const caught = await handler(cli(["trust", "peer"]));
    expect(caught.ok).toBe(false);
    expect(caught.error).toBeString();
  });
});
