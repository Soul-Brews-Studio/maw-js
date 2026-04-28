/**
 * inbox-cli — approval-queue CLI command tests (#842 Sub-C).
 *
 * Covers the queue-side commands added to the `inbox` plugin:
 *   - cmdQueueList — pending only, oldest first
 *   - cmdShow      — single message lookup (exact id + prefix match)
 *   - cmdApprove   — flip status + execute send + delete file
 *   - cmdReject    — flip status + delete file
 *   - resolvePendingId — id resolution semantics
 *
 * The send execution inside `cmdApprove` is mocked at the comm-send module
 * level so the test stays isolated from tmux + federation.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

// Mocked `cmdSend` — captures invocations so cmdApprove's re-issue path is
// observable without touching the real transport stack.
let sendCalls: Array<{ query: string; message: string; bypass: string | undefined }> = [];

mock.module(join(import.meta.dir, "../../src/commands/shared/comm-send"), () => ({
  cmdSend: async (query: string, message: string) => {
    sendCalls.push({ query, message, bypass: process.env.MAW_ACL_BYPASS });
  },
}));

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-inbox-cli-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = testDir;
  delete process.env.MAW_HOME;
  sendCalls = [];
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("inbox-cli — cmdQueueList", () => {
  test("returns [] when no pending messages", async () => {
    const { cmdQueueList } = await import("../../src/commands/plugins/inbox/impl");
    expect(cmdQueueList()).toEqual([]);
  });

  test("returns pending messages oldest first", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdQueueList } = await import("../../src/commands/plugins/inbox/impl");
    const r1 = savePending({ sender: "a", target: "b", message: "first" });
    await new Promise(res => setTimeout(res, 5));
    const r2 = savePending({ sender: "a", target: "c", message: "second" });
    const list = cmdQueueList();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(r1.id);
    expect(list[1].id).toBe(r2.id);
  });

  test("excludes already-approved messages", async () => {
    const { savePending, updatePending } = await import("../../src/commands/shared/queue-store");
    const { cmdQueueList } = await import("../../src/commands/plugins/inbox/impl");
    const r1 = savePending({ sender: "a", target: "b", message: "m1" });
    const r2 = savePending({ sender: "a", target: "c", message: "m2" });
    updatePending(r1.id, { status: "approved" });
    const list = cmdQueueList();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(r2.id);
  });
});

describe("inbox-cli — cmdShow / resolvePendingId", () => {
  test("cmdShow returns the message by exact id", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdShow } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "hi" });
    const got = cmdShow(rec.id);
    expect(got?.id).toBe(rec.id);
    expect(got?.message).toBe("hi");
  });

  test("cmdShow returns null for unknown id", async () => {
    const { cmdShow } = await import("../../src/commands/plugins/inbox/impl");
    expect(cmdShow("does-not-exist")).toBeNull();
  });

  test("resolvePendingId prefix-matches when no exact match", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { resolvePendingId } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    const prefix = rec.id.slice(0, 10);
    const got = resolvePendingId(prefix);
    expect(got?.id).toBe(rec.id);
  });

  test("resolvePendingId returns null on empty input", async () => {
    const { resolvePendingId } = await import("../../src/commands/plugins/inbox/impl");
    expect(resolvePendingId("")).toBeNull();
  });
});

describe("inbox-cli — cmdApprove", () => {
  test("approve flips status, calls cmdSend, then deletes file", async () => {
    const { savePending, loadPendingById } = await import("../../src/commands/shared/queue-store");
    const { cmdApprove } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "hi", query: "node:b" });

    const result = await cmdApprove(rec.id);
    expect(result.status).toBe("approved");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].query).toBe("node:b");
    expect(sendCalls[0].message).toBe("hi");
    // ACL bypass env was set DURING the cmdSend invocation.
    expect(sendCalls[0].bypass).toBe("1");
    // File removed after successful send.
    expect(loadPendingById(rec.id)).toBeNull();
  });

  test("approve throws on unknown id", async () => {
    const { cmdApprove } = await import("../../src/commands/plugins/inbox/impl");
    await expect(cmdApprove("nope")).rejects.toThrow(/not found/);
  });

  test("approve uses target as fallback query when query field absent", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdApprove } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "beta", message: "hi" });
    await cmdApprove(rec.id);
    expect(sendCalls[0].query).toBe("beta");
  });

  test("approve clears MAW_ACL_BYPASS after the send", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdApprove } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    await cmdApprove(rec.id);
    // After cmdApprove returns, the env is restored.
    expect(process.env.MAW_ACL_BYPASS).toBeUndefined();
  });

  test("approve refuses to re-approve an already-approved record", async () => {
    const { savePending, updatePending } = await import("../../src/commands/shared/queue-store");
    const { cmdApprove } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    updatePending(rec.id, { status: "approved" });
    await expect(cmdApprove(rec.id)).rejects.toThrow(/already approved/);
  });
});

describe("inbox-cli — cmdReject", () => {
  test("reject flips status to rejected, then deletes the file", async () => {
    const { savePending, loadPendingById } = await import("../../src/commands/shared/queue-store");
    const { cmdReject } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    const result = cmdReject(rec.id);
    expect(result.status).toBe("rejected");
    expect(loadPendingById(rec.id)).toBeNull();
  });

  test("reject does NOT call cmdSend", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdReject } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "m" });
    cmdReject(rec.id);
    expect(sendCalls).toHaveLength(0);
  });

  test("reject throws on unknown id", async () => {
    const { cmdReject } = await import("../../src/commands/plugins/inbox/impl");
    expect(() => cmdReject("nope")).toThrow(/not found/);
  });
});

describe("inbox-cli — formatters", () => {
  test("formatQueueList shows the empty state", async () => {
    const { formatQueueList } = await import("../../src/commands/plugins/inbox/impl");
    expect(formatQueueList([])).toMatch(/no pending/);
  });

  test("formatQueueList includes id, sender, target, sentAt", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdQueueList, formatQueueList } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "alpha", target: "beta", message: "hi" });
    const out = formatQueueList(cmdQueueList());
    expect(out).toContain(rec.id);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  test("formatQueueDetail surfaces all fields including query", async () => {
    const { savePending } = await import("../../src/commands/shared/queue-store");
    const { cmdShow, formatQueueDetail } = await import("../../src/commands/plugins/inbox/impl");
    const rec = savePending({ sender: "a", target: "b", message: "hello world", query: "node:b" });
    const got = cmdShow(rec.id)!;
    const out = formatQueueDetail(got);
    expect(out).toContain("hello world");
    expect(out).toContain("node:b");
    expect(out).toContain("pending");
  });
});
