import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const tmpRoot = join(tmpdir(), `maw-inbox-drain-all-${process.pid}`);
const psiPath = join(tmpRoot, "psi");
const inboxDir = join(psiPath, "inbox");

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  loadConfig: () => ({ psiPath, node: "codex-5", oracle: "codex-5" }),
  ghqFind: async () => null,
  loadFleetEntries: () => [],
  hostExec: async () => "",
  updateInboxStatusBadge: async () => ({ status: "cleared" }),
}));

const { cmdInboxDrain, getInboxStatus } = await import("../../src/vendor/mpr-plugins/inbox/impl.ts?drain-all");
const { default: handler } = await import("../../src/vendor/mpr-plugins/inbox/index.ts?drain-all");

const NOW = new Date("2026-08-28T12:00:00.000Z").getTime();

function writeMsg(name: string, body: string, opts: { read?: boolean; ts?: string } = {}) {
  const ts = opts.ts ?? "2026-08-20T10:00:00.000Z";
  writeFileSync(join(inboxDir, name), `---\nfrom: peer\nto: codex-5\ntimestamp: ${ts}\nread: ${opts.read ? "true" : "false"}\n---\n${body}\n`);
}

function topLevel(): string[] {
  return readdirSync(inboxDir).filter(f => f.endsWith(".md")).sort();
}

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(inboxDir, { recursive: true });
  // Three messages: an old unread question (never --safe eligible), an old read ack, a fresh unread.
  writeMsg("2026-08-20_10-00_peer_question.md", "[peer] which issue should I take?", { ts: "2026-08-20T10:00:00.000Z" });
  writeMsg("2026-08-21_10-00_peer_ack.md", "[peer] ci green confirmed", { read: true, ts: "2026-08-21T10:00:00.000Z" });
  writeMsg("2026-08-28_11-30_peer_fresh.md", "[peer] fresh directive", { ts: "2026-08-28T11:30:00.000Z" });
});

describe("maw inbox drain --all (bulk owner archive)", () => {
  test("--safe still ignores questions and fresh messages", async () => {
    const r = await cmdInboxDrain(undefined, { safe: true, dryRun: true, json: true }, NOW);
    expect(r.mode).toBe("safe");
    expect(r.matched).toBe(1);
    expect(r.items[0].filename).toBe("2026-08-21_10-00_peer_ack.md");
    expect(topLevel().length).toBe(3);
  });

  test("--all --dry-run previews every top-level message without moving anything", async () => {
    const r = await cmdInboxDrain(undefined, { all: true, dryRun: true, json: true }, NOW);
    expect(r.mode).toBe("all");
    expect(r.safe).toBe(false);
    expect(r.scanned).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.archived).toBe(3);
    expect(r.items.every(i => i.action === "would_archive")).toBe(true);
    expect(r.items.map(i => i.reason).sort()).toEqual(["all:read", "all:unread", "all:unread"]);
    expect(topLevel().length).toBe(3);
    expect(existsSync(join(inboxDir, "processed"))).toBe(false);
  });

  test("--all archives into processed/<date> and unread count drops to 0", async () => {
    const before = await getInboxStatus(undefined, NOW);
    expect(before.unread).toBe(2);
    const r = await cmdInboxDrain(undefined, { all: true, json: true }, NOW);
    expect(r.archived).toBe(3);
    expect(r.remaining_matches).toBe(0);
    expect(topLevel()).toEqual([]);
    const day = join(inboxDir, "processed", "2026-08-28");
    expect(readdirSync(day).sort()).toEqual([
      "2026-08-20_10-00_peer_question.md",
      "2026-08-21_10-00_peer_ack.md",
      "2026-08-28_11-30_peer_fresh.md",
    ]);
    const after = await getInboxStatus(undefined, NOW);
    expect(after.unread).toBe(0);
    expect(after.level).toBe("green");
  });

  test("--all honours --older-than-hours and --max (oldest first)", async () => {
    const r = await cmdInboxDrain(undefined, { all: true, olderThanSeconds: 24 * 3600, max: 1, json: true }, NOW);
    expect(r.matched).toBe(2); // fresh (30 min) excluded
    expect(r.archived).toBe(1);
    expect(r.remaining_matches).toBe(1);
    expect(r.items[0].filename).toBe("2026-08-20_10-00_peer_question.md");
    expect(topLevel()).toEqual(["2026-08-21_10-00_peer_ack.md", "2026-08-28_11-30_peer_fresh.md"]);
  });

  test("rejects --safe together with --all, and neither", async () => {
    await expect(cmdInboxDrain(undefined, { safe: true, all: true }, NOW)).rejects.toThrow(/mutually exclusive/);
    await expect(cmdInboxDrain(undefined, {}, NOW)).rejects.toThrow(/usage:/);
  });

  test("CLI handler wires --all and rejects the flag combination", async () => {
    const bad = await handler({ source: "cli", args: ["drain", "--safe", "--all"] } as any);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/mutually exclusive/);
    const none = await handler({ source: "cli", args: ["drain"] } as any);
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/\(--safe \| --all\)/);
    const dry = await handler({ source: "cli", args: ["drain", "--all", "--dry-run", "--older-than-hours", "24"] } as any);
    expect(dry.ok).toBe(true);
    expect(dry.output).toContain("would archive 2/2 inbox message(s) [--all]");
    expect(topLevel().length).toBe(3);
  });
});
