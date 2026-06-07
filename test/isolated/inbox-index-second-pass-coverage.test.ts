import { beforeEach, describe, expect, mock, test } from "bun:test";

const implPath = import.meta.resolve("../../src/vendor/mpr-plugins/inbox/impl");

type PendingLike = {
  id: string;
  sender: string;
  target: string;
  sentAt?: string;
  message?: string;
};

let queueRows: PendingLike[] = [];
let formatQueueListResult = "formatted pending queue";
let formatQueueDetailResult = "formatted pending detail";
let approveResult: PendingLike = { id: "ap-1", sender: "alice", target: "bob" };
let rejectResult: PendingLike = { id: "rj-1", sender: "carol", target: "dave" };
let showResult: PendingLike | null = { id: "show-1", sender: "eve", target: "frank" };
let throwLabel: string | null = null;

let queueListCalls = 0;
let formatQueueListCalls: PendingLike[][] = [];
let approveCalls: string[] = [];
let rejectCalls: string[] = [];
let showCalls: string[] = [];
let formatQueueDetailCalls: PendingLike[] = [];
let inboxLsCalls: Array<{ unread?: boolean; from?: string; last?: number }> = [];
let markReadCalls: string[] = [];
let inboxReadCalls: Array<string | undefined> = [];
let inboxWriteCalls: string[] = [];
let inboxStatusCalls: Array<{ oracle?: string; json?: boolean; all?: boolean }> = [];
let inboxDrainCalls: Array<{
  oracle?: string;
  safe?: boolean;
  max?: number;
  json?: boolean;
  dryRun?: boolean;
  olderThanSeconds?: number;
}> = [];

mock.module(implPath, () => ({
  cmdQueueList: () => {
    queueListCalls += 1;
    if (throwLabel === "queue-list") throw new Error("queue list exploded");
    return queueRows;
  },
  formatQueueList: (rows: PendingLike[]) => {
    formatQueueListCalls.push(rows);
    if (throwLabel === "format-queue-list") throw new Error("format queue list exploded");
    return formatQueueListResult;
  },
  cmdApprove: async (id: string) => {
    approveCalls.push(id);
    if (throwLabel === "approve") throw new Error("approve exploded");
    return approveResult;
  },
  cmdReject: (id: string) => {
    rejectCalls.push(id);
    if (throwLabel === "reject") throw new Error("reject exploded");
    return rejectResult;
  },
  cmdShow: (id: string) => {
    showCalls.push(id);
    if (throwLabel === "show") throw new Error("show exploded");
    return showResult;
  },
  formatQueueDetail: (msg: PendingLike) => {
    formatQueueDetailCalls.push(msg);
    if (throwLabel === "format-detail") throw new Error("format detail exploded");
    return formatQueueDetailResult;
  },
  cmdInboxLs: async (opts: { unread?: boolean; from?: string; last?: number }) => {
    inboxLsCalls.push(opts);
    console.log("legacy ls");
    if (throwLabel === "inbox-ls") {
      console.error("legacy ls stderr");
      throw new Error("inbox ls exploded");
    }
  },
  cmdInboxMarkRead: async (id: string) => {
    markReadCalls.push(id);
    console.log(`marked ${id || "missing"}`);
    if (throwLabel === "mark-read") throw new Error("mark read exploded");
  },
  cmdInboxRead: async (id?: string) => {
    inboxReadCalls.push(id);
    console.log(`read ${id ?? "latest"}`);
    console.error(`read stderr ${id ?? "latest"}`);
    if (throwLabel === "inbox-read") throw new Error("inbox read exploded");
  },
  cmdInboxStatus: async (oracle?: string, opts?: { json?: boolean; all?: boolean }) => {
    inboxStatusCalls.push({ oracle, json: opts?.json, all: opts?.all });
    const target = opts?.all ? "all" : (oracle ?? "current");
    console.log(opts?.json ? `json status ${target}` : `status ${target}`);
    if (throwLabel === "inbox-status") throw new Error("inbox status exploded");
  },
  cmdInboxDrain: async (oracle?: string, opts?: {
    safe?: boolean;
    max?: number;
    json?: boolean;
    dryRun?: boolean;
    olderThanSeconds?: number;
  }) => {
    inboxDrainCalls.push({
      oracle,
      safe: opts?.safe,
      max: opts?.max,
      json: opts?.json,
      dryRun: opts?.dryRun,
      olderThanSeconds: opts?.olderThanSeconds,
    });
    console.log(opts?.json ? `json drain ${oracle ?? "current"}` : `drain ${oracle ?? "current"}`);
    if (throwLabel === "inbox-drain") throw new Error("inbox drain exploded");
  },
  cmdInboxWrite: async (note: string) => {
    inboxWriteCalls.push(note);
    console.log(`wrote ${note}`);
    if (throwLabel === "inbox-write") throw new Error("inbox write exploded");
  },
}));

const { command, default: handler } = await import(
  "../../src/vendor/mpr-plugins/inbox/index.ts?inbox-index-second-pass-coverage"
);

beforeEach(() => {
  queueRows = [
    { id: "q-1", sender: "alice", target: "bob", sentAt: "2026-05-18T00:00:00.000Z", message: "hello" },
  ];
  formatQueueListResult = "formatted pending queue";
  formatQueueDetailResult = "formatted pending detail";
  approveResult = { id: "ap-1", sender: "alice", target: "bob" };
  rejectResult = { id: "rj-1", sender: "carol", target: "dave" };
  showResult = { id: "show-1", sender: "eve", target: "frank" };
  throwLabel = null;

  queueListCalls = 0;
  formatQueueListCalls = [];
  approveCalls = [];
  rejectCalls = [];
  showCalls = [];
  formatQueueDetailCalls = [];
  inboxLsCalls = [];
  markReadCalls = [];
  inboxReadCalls = [];
  inboxWriteCalls = [];
  inboxStatusCalls = [];
  inboxDrainCalls = [];
});

function invoke(args: string[] | Record<string, unknown>, writer?: (...args: unknown[]) => void) {
  return handler({
    source: Array.isArray(args) ? "cli" : "api",
    args,
    writer,
  } as any);
}

describe("inbox plugin index", () => {
  test("exports metadata and routes pending aliases through the queue formatter", async () => {
    expect(command).toEqual({
      name: "inbox",
      description: "Inbox messages + cross-scope approval queue (#842 Sub-C).",
    });

    const result = await invoke(["pending"]);
    expect(result).toEqual({ ok: true, output: "formatted pending queue" });
    expect(queueListCalls).toBe(1);
    expect(formatQueueListCalls).toEqual([queueRows]);

    const writes: string[] = [];
    const writerResult = await invoke(["queue"], (...parts: unknown[]) => {
      writes.push(parts.map(String).join(" "));
    });
    expect(writerResult).toEqual({ ok: true, output: "" });
    expect(queueListCalls).toBe(2);
    expect(writes).toEqual(["formatted pending queue"]);
  });

  test("handles approve and reject usage, success, and command-level failures", async () => {
    expect(await invoke(["approve"])).toEqual({
      ok: false,
      error: "usage: maw inbox approve <id>",
      output: "",
    });
    expect(approveCalls).toEqual([]);

    expect(await invoke(["approve", "ap-1"])).toEqual({
      ok: true,
      output: "approved: ap-1 (alice → bob)",
    });
    expect(approveCalls).toEqual(["ap-1"]);

    throwLabel = "approve";
    expect(await invoke(["approve", "bad-approve"])).toEqual({
      ok: false,
      error: "approve exploded",
      output: "",
    });

    throwLabel = null;
    expect(await invoke(["reject"])).toEqual({
      ok: false,
      error: "usage: maw inbox reject <id>",
      output: "",
    });
    expect(rejectCalls).toEqual([]);

    expect(await invoke(["reject", "rj-1"])).toEqual({
      ok: true,
      output: "rejected: rj-1 (carol → dave)",
    });
    expect(rejectCalls).toEqual(["rj-1"]);

    throwLabel = "reject";
    expect(await invoke(["reject", "bad-reject"])).toEqual({
      ok: false,
      error: "reject exploded",
      output: "",
    });
  });

  test("handles show-pending aliases, usage, not-found, and formatter failures", async () => {
    expect(await invoke(["show-pending"])).toEqual({
      ok: false,
      error: "usage: maw inbox show-pending <id>",
      output: "",
    });

    let result = await invoke(["pending-show", "show-1"]);
    expect(result).toEqual({ ok: true, output: "formatted pending detail" });
    expect(showCalls).toEqual(["show-1"]);
    expect(formatQueueDetailCalls).toEqual([showResult]);

    showResult = null;
    result = await invoke(["show-pending", "missing"]);
    expect(result).toEqual({
      ok: false,
      error: "pending message not found: missing",
      output: "",
    });

    showResult = { id: "show-2", sender: "eve", target: "frank" };
    throwLabel = "format-detail";
    result = await invoke(["show-pending", "show-2"]);
    expect(result).toEqual({ ok: false, error: "format detail exploded", output: undefined });
  });

  test("routes legacy read, show, write, and list commands with parsed flags", async () => {
    expect(await invoke(["read", "abc"])).toEqual({ ok: true, output: "marked abc" });
    expect(await invoke(["read"])).toEqual({ ok: true, output: "marked missing" });
    expect(markReadCalls).toEqual(["abc", ""]);

    let writes: string[] = [];
    const showResultWithWriter = await invoke(["show", "2"], (...parts: unknown[]) => {
      writes.push(parts.map(String).join(" "));
    });
    expect(showResultWithWriter).toEqual({ ok: true, output: undefined });
    expect(inboxReadCalls).toEqual(["2"]);
    expect(writes).toEqual(["read 2", "read stderr 2"]);

    expect(await invoke(["status"])).toEqual({ ok: true, output: "status current" });
    expect(await invoke(["status", "mawjs-codex-oracle", "--json"])).toEqual({
      ok: true,
      output: "json status mawjs-codex-oracle",
    });
    expect(await invoke(["status", "--json"])).toEqual({ ok: true, output: "json status current" });
    expect(await invoke(["status", "--all", "--json"])).toEqual({ ok: true, output: "json status all" });
    expect(await invoke(["status", "--all", "mawjs-codex-oracle"])).toEqual({
      ok: false,
      error: "usage: maw inbox status [oracle-name] [--json] [--all]",
      output: "",
    });
    expect(inboxStatusCalls).toEqual([
      { oracle: undefined, json: false, all: false },
      { oracle: "mawjs-codex-oracle", json: true, all: false },
      { oracle: undefined, json: true, all: false },
      { oracle: undefined, json: true, all: true },
    ]);

    expect(await invoke(["drain"])).toEqual({
      ok: false,
      error: "usage: maw inbox drain [oracle-name] --safe [--max N] [--older-than-hours H] [--json] [--dry-run]",
      output: "",
    });
    expect(await invoke(["drain", "mawjs-oracle", "--safe", "--max=7", "--older-than-hours", "12", "--json", "--dry-run"])).toEqual({
      ok: true,
      output: "json drain mawjs-oracle",
    });
    expect(await invoke(["drain", "--safe", "--max", "bad"])).toEqual({
      ok: false,
      error: "--max must be a non-negative integer",
      output: "",
    });
    expect(inboxDrainCalls).toEqual([
      {
        oracle: "mawjs-oracle",
        safe: true,
        max: 7,
        json: true,
        dryRun: true,
        olderThanSeconds: 12 * 60 * 60,
      },
    ]);

    expect(await invoke(["write", "hello", "world"])).toEqual({ ok: true, output: "wrote hello world" });
    expect(inboxWriteCalls).toEqual(["hello world"]);

    expect(await invoke(["--unread", "--from", "alice", "--last", "3"])).toEqual({
      ok: true,
      output: "legacy ls",
    });
    expect(await invoke(["--last", "0"])).toEqual({ ok: true, output: "legacy ls" });
    expect(await invoke({ ignored: true })).toEqual({ ok: true, output: "legacy ls" });
    expect(inboxLsCalls).toEqual([
      { unread: true, from: "alice", last: 3 },
      { unread: false, from: undefined, last: 20 },
      { unread: false, from: undefined, last: undefined },
    ]);
  });

  test("restores console.log and console.error after a top-level failure", async () => {
    const origLog = console.log;
    const origError = console.error;

    throwLabel = "inbox-ls";
    const result = await invoke(["--unread"]);

    expect(result).toEqual({
      ok: false,
      error: "inbox ls exploded",
      output: "legacy ls\nlegacy ls stderr",
    });
    expect(inboxLsCalls).toEqual([{ unread: true, from: undefined, last: undefined }]);
    expect(console.log).toBe(origLog);
    expect(console.error).toBe(origError);
  });
});
