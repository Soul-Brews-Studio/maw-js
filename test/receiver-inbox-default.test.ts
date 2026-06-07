import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultReceiverInboxWriter,
  persistReceiverInbox,
  receiverInboxAutoWriteEnabled,
  resolveReceiverOracle,
} from "../src/commands/shared/receiver-inbox";

describe("receiver inbox auto-write helpers", () => {
  test("defaults on in production and off in test mode unless explicitly enabled", () => {
    expect(receiverInboxAutoWriteEnabled({} as any)).toBe(true);
    expect(receiverInboxAutoWriteEnabled({ MAW_TEST_MODE: "1" } as any)).toBe(false);
    expect(receiverInboxAutoWriteEnabled({ MAW_TEST_MODE: "1", MAW_HEY_INBOX_AUTOWRITE: "1" } as any)).toBe(true);
    expect(receiverInboxAutoWriteEnabled({ MAW_HEY_INBOX_AUTOWRITE: "off" } as any)).toBe(false);

    const oldTestMode = process.env.MAW_TEST_MODE;
    const oldAutoWrite = process.env.MAW_HEY_INBOX_AUTOWRITE;
    try {
      process.env.MAW_TEST_MODE = "1";
      delete process.env.MAW_HEY_INBOX_AUTOWRITE;
      expect(defaultReceiverInboxWriter()).toBeNull();
      process.env.MAW_HEY_INBOX_AUTOWRITE = "1";
      expect(typeof defaultReceiverInboxWriter()).toBe("function");
    } finally {
      if (oldTestMode === undefined) delete process.env.MAW_TEST_MODE;
      else process.env.MAW_TEST_MODE = oldTestMode;
      if (oldAutoWrite === undefined) delete process.env.MAW_HEY_INBOX_AUTOWRITE;
      else process.env.MAW_HEY_INBOX_AUTOWRITE = oldAutoWrite;
    }
  });

  test("infers receiver oracle from explicit to, tmux target, and node-prefixed query", () => {
    expect(resolveReceiverOracle({ query: "m5:digger", to: "m5:mawjs", target: "54-digger:digger-oracle.0", from: "m5:sender", message: "hi" })).toBe("mawjs");
    expect(resolveReceiverOracle({ query: "m5:digger", target: "54-digger:digger-oracle.0", from: "m5:sender", message: "hi" })).toBe("digger");
    expect(resolveReceiverOracle({ query: "m5:digger", from: "m5:sender", message: "hi" })).toBe("digger");
    expect(resolveReceiverOracle({ query: "digger-oracle", from: "m5:sender", message: "hi" })).toBe("digger");
  });

  test("writes markdown frontmatter to the receiver ψ/inbox using target cwd first", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-receiver-inbox-"));
    const repo = join(root, "digger-oracle");
    mkdirSync(repo, { recursive: true });

    const result = persistReceiverInbox({
      query: "m5:digger",
      target: "54-digger:digger-oracle.0",
      from: "m5:sender",
      message: "[m5:sender] ralph-dig: oracle-status-tray",
      config: { node: "m5", oracle: "sender" },
    }, {
      resolveTargetCwd: () => repo,
      loadManifest: () => [],
      getGhqRoot: () => root,
      ghqFindSync: () => null,
      now: () => new Date("2026-05-17T08:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.oracle).toBe("digger");
    expect(result.filename).toBe("2026-05-17_08-00_m5-sender_m5-sender-ralph-dig-oracle-status-tray.md");
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toContain("from: m5:sender");
    expect(readFileSync(result.path, "utf-8")).toContain("to: digger");
    expect(readFileSync(result.path, "utf-8")).toContain("[m5:sender] ralph-dig: oracle-status-tray");
  });

  test("falls back to manifest repo path and reports misses without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-receiver-inbox-manifest-"));
    const repo = join(root, "github.com", "Soul-Brews-Studio", "digger-oracle");
    mkdirSync(repo, { recursive: true });

    const ok = persistReceiverInbox({
      query: "digger",
      from: "m5:sender",
      message: "queue me",
    }, {
      resolveTargetCwd: () => null,
      loadManifest: () => [{ name: "digger", sources: ["fleet"], repo: "Soul-Brews-Studio/digger-oracle", isLive: false }],
      getGhqRoot: () => root,
      ghqFindSync: () => null,
      now: () => new Date("2026-05-17T08:01:00.000Z"),
    });

    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.inboxDir).toBe(join(repo, "ψ", "inbox"));

    const miss = persistReceiverInbox({
      query: "ghost",
      from: "m5:sender",
      message: "lost",
    }, {
      resolveTargetCwd: () => null,
      loadManifest: () => [],
      getGhqRoot: () => root,
      ghqFindSync: () => null,
    });
    expect(miss).toEqual({ ok: false, oracle: "ghost", reason: "receiver repo not found for ghost" });
  });

  test("handles psiPath, discovery exceptions, and write failures safely", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-receiver-inbox-errors-"));
    const repo = join(root, "current-oracle");
    mkdirSync(repo, { recursive: true });

    const psi = persistReceiverInbox({
      query: "current",
      from: "m5:sender",
      message: "via psi path",
      config: { oracle: "current", psiPath: join(repo, "ψ") },
    }, {
      loadManifest: () => { throw new Error("manifest boom"); },
      ghqFindSync: () => { throw new Error("ghq boom"); },
      getGhqRoot: () => root,
      now: () => new Date("2026-05-17T08:02:00.000Z"),
    });
    expect(psi.ok).toBe(true);
    if (psi.ok) expect(psi.inboxDir).toBe(join(repo, "ψ", "inbox"));

    const noRepo = persistReceiverInbox({
      query: "current",
      from: "m5:sender",
      message: "exists throws",
      config: { oracle: "current", psiPath: join(root, "bad", "ψ") },
    }, {
      loadManifest: () => { throw new Error("manifest boom"); },
      ghqFindSync: () => { throw new Error("ghq boom"); },
      getGhqRoot: () => root,
      existsSync: () => { throw new Error("exists boom"); },
    });
    expect(noRepo).toEqual({ ok: false, oracle: "current", reason: "receiver repo not found for current" });

    const writeFail = persistReceiverInbox({
      query: "current",
      from: "m5:sender",
      message: "write fails",
      config: { oracle: "current", psiPath: join(repo, "ψ") },
    }, {
      getGhqRoot: () => root,
      writeFileSync: () => { throw new Error("disk full"); },
    });
    expect(writeFail).toEqual({ ok: false, oracle: "current", reason: "disk full" });
  });
});
