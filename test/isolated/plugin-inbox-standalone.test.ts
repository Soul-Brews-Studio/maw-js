import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const pluginDir = join(root, "src/vendor/mpr-plugins/inbox");
const tmpRoot = join(tmpdir(), `maw-inbox-standalone-${process.pid}`);
const psiPath = join(tmpRoot, "psi");

let pending: any[] = [];
let deleted: string[] = [];
let updated: Array<{ id: string; patch: any }> = [];
let sent: Array<{ target: string; message: string; force?: boolean }> = [];
let ghqCalls: string[] = [];
let statusBadgeCalls: Array<{ target: string; unread: number }> = [];
let hostExecCalls: string[] = [];

const sdkMock = {
  loadConfig: () => ({ psiPath, node: "codex-5", oracle: "codex-5" }),
  ghqFind: async (pattern: string) => {
    ghqCalls.push(pattern);
    return null;
  },
  loadFleetEntries: () => [],
  loadPending: () => pending,
  loadPendingById: (id: string) => pending.find((msg) => msg.id === id) ?? null,
  updatePending: (id: string, patch: any) => {
    updated.push({ id, patch });
    const msg = pending.find((item) => item.id === id);
    if (!msg) throw new Error(`pending message not found: ${id}`);
    Object.assign(msg, patch);
    return msg;
  },
  deletePending: (id: string) => {
    deleted.push(id);
    pending = pending.filter((msg) => msg.id !== id);
    return true;
  },
  savePending: (input: any) => {
    const msg = { id: `p${pending.length + 1}`, sentAt: new Date(0).toISOString(), status: "pending", ...input };
    pending.push(msg);
    return msg;
  },
  pendingDir: () => join(tmpRoot, "state", "pending"),
  pendingPath: (id: string) => join(tmpRoot, "state", "pending", `${id}.json`),
  isExpired: () => false,
  TTL_MS: 30 * 24 * 60 * 60 * 1000,
  cmdSend: async (target: string, message: string, force?: boolean) => {
    sent.push({ target, message, force });
  },
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "mock-session\n";
  },
  updateInboxStatusBadge: async (target: string, unread: number) => {
    statusBadgeCalls.push({ target, unread });
    return { status: unread > 0 ? "set" : "cleared", session: target, unread };
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/inbox/index.ts");
const {
  cmdInboxMarkRead,
  cmdInboxWrite,
  cmdQueueList,
  formatQueueDetail,
  formatQueueList,
  relativeTime,
  resolvePendingId,
} = await import("../../src/vendor/mpr-plugins/inbox/impl.ts");

function importsOf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...importsOf(full));
    else if (entry.name.endsWith(".ts")) {
      const source = readFileSync(full, "utf8");
      const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) out.push(match[1] ?? match[2]);
    }
  }
  return out;
}

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(join(psiPath, "inbox"), { recursive: true });
  pending = [
    { id: "abc123", sender: "m1", target: "codex-5", message: "hello from queue", sentAt: "2026-06-06T00:00:00.000Z", status: "pending", query: "codex-5" },
    { id: "old999", sender: "m2", target: "codex-4", message: "already approved", sentAt: "2026-06-05T00:00:00.000Z", status: "approved" },
  ];
  deleted = [];
  updated = [];
  sent = [];
  ghqCalls = [];
  statusBadgeCalls = [];
  hostExecCalls = [];
});

describe("inbox plugin standalone boundary (#2329)", () => {
  test("uses SDK or local/platform imports only", () => {
    const imports = importsOf(pluginDir);
    const forbidden = imports.filter((spec) =>
      spec.startsWith("maw-js/core/")
      || spec.startsWith("maw-js/commands/shared/")
      || spec.startsWith("maw-js/plugin")
      || spec.startsWith("maw-js/config"),
    );

    expect(command).toMatchObject({ name: "inbox" });
    expect(imports).toContain("maw-js/sdk");
    expect(forbidden).toEqual([]);
  });

  test("queue helpers list pending rows and resolve exact or prefix ids", () => {
    expect(cmdQueueList().map((msg: any) => msg.id)).toEqual(["abc123"]);
    expect(resolvePendingId("abc123")?.message).toBe("hello from queue");
    expect(resolvePendingId("abc")?.id).toBe("abc123");
    expect(formatQueueList(cmdQueueList())).toContain("hello from queue");
    expect(formatQueueDetail(pending[0])).toContain("query:   codex-5");
  });

  test("handler pending/show/reject paths stay inside SDK queue seams", async () => {
    const listed = await handler({ source: "cli", args: ["pending"] } as any);
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("abc123");

    const shown = await handler({ source: "cli", args: ["show-pending", "abc"] } as any);
    expect(shown.ok).toBe(true);
    expect(shown.output).toContain("message:");

    const rejected = await handler({ source: "cli", args: ["reject", "abc"] } as any);
    expect(rejected.ok).toBe(true);
    expect(updated).toEqual([{ id: "abc123", patch: { status: "rejected" } }]);
    expect(deleted).toEqual(["abc123"]);
  });

  test("approve marks approved, sends through SDK cmdSend, then deletes", async () => {
    const approved = await handler({ source: "cli", args: ["approve", "abc"] } as any);

    expect(approved.ok).toBe(true);
    expect(updated).toEqual([{ id: "abc123", patch: { status: "approved" } }]);
    expect(sent).toEqual([{ target: "codex-5", message: "hello from queue", force: undefined }]);
    expect(deleted).toEqual(["abc123"]);
  });


  test("mark-read robustly updates compact or missing read frontmatter", async () => {
    const inbox = join(psiPath, "inbox");
    const compact = join(inbox, "2026-06-09_00-01_sender_compact.md");
    const missing = join(inbox, "2026-06-09_00-02_sender_missing.md");
    writeFileSync(compact, [
      "---",
      "from: sender",
      "timestamp: 2026-06-09T00:01:00.000Z",
      "read:false",
      "---",
      "",
      "compact read flag",
    ].join("\n"));
    writeFileSync(missing, [
      "---",
      "from: sender",
      "timestamp: 2026-06-09T00:02:00.000Z",
      "---",
      "",
      "missing read flag",
    ].join("\n"));

    const prevTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-test/default,123,0";
    try {
      await cmdInboxMarkRead("compact");
      await cmdInboxMarkRead("missing");
    } finally {
      if (prevTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = prevTmux;
    }

    expect(readFileSync(compact, "utf8")).toContain("read: true");
    expect(readFileSync(compact, "utf8")).toContain("readAt:");
    expect(readFileSync(missing, "utf8")).toContain("read: true");
    expect(readFileSync(missing, "utf8")).toContain("readAt:");
    expect(hostExecCalls).toEqual([
      "tmux display-message -p '#S'",
      "tmux display-message -p '#S'",
    ]);
    expect(statusBadgeCalls).toEqual([
      { target: "mock-session", unread: 0 },
      { target: "mock-session", unread: 0 },
    ]);
  });

  test("mark-read upgrades a legacy message without frontmatter", async () => {
    const inbox = join(psiPath, "inbox");
    const legacy = join(inbox, "2026-06-09_00-03_legacy.md");
    const body = "# Legacy review request\n\nKeep this body byte-for-byte.\n";
    writeFileSync(legacy, body);

    await cmdInboxMarkRead("legacy");

    const updated = readFileSync(legacy, "utf8");
    expect(updated).toStartWith("---\n");
    expect(updated).toContain("read: true");
    expect(updated).toContain("readAt:");
    expect(updated.endsWith(body)).toBe(true);

    const listed = await handler({ source: "cli", args: ["--unread", "--last", "5"] } as any);
    expect(listed.ok).toBe(true);
    expect(listed.output).not.toContain("Legacy review request");
  });

  test("checking the inbox clears the arrival badge without rewriting unread history", async () => {
    const inbox = join(psiPath, "inbox");
    const message = join(inbox, "2026-06-09_00-03_sender_unread.md");
    writeFileSync(message, [
      "---",
      "from: sender",
      "timestamp: 2026-06-09T00:03:00.000Z",
      "read: false",
      "---",
      "",
      "new arrival",
    ].join("\n"));

    const prevTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-test/default,123,0";
    try {
      const listed = await handler({ source: "cli", args: ["--unread", "--last", "5"] } as any);
      expect(listed.ok).toBe(true);
      expect(listed.output).toContain("new arrival");
    } finally {
      if (prevTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = prevTmux;
    }

    expect(readFileSync(message, "utf8")).toContain("read: false");
    expect(statusBadgeCalls).toEqual([{ target: "mock-session", unread: 0 }]);
  });

  test("read displays the selected message and marks it read", async () => {
    const inbox = join(psiPath, "inbox");
    const message = join(inbox, "2026-06-09_00-04_sender_consume.md");
    writeFileSync(message, [
      "---",
      "from: sender",
      "timestamp: 2026-06-09T00:04:00.000Z",
      "read: false",
      "---",
      "",
      "consume me",
    ].join("\n"));

    const result = await handler({ source: "cli", args: ["read", "1"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("consume me");
    expect(result.output).toContain("marked read");
    expect(readFileSync(message, "utf8")).toContain("read: true");
  });

  test("unread listing keeps absolute positions so deep reads mark the displayed message", async () => {
    const inbox = join(psiPath, "inbox");
    let unreadPath = "";
    for (let position = 45; position >= 1; position -= 1) {
      const minute = String(46 - position).padStart(2, "0");
      const path = join(inbox, `2026-06-09_00-${minute}_sender_message-${position}.md`);
      const unread = position === 45;
      if (unread) unreadPath = path;
      writeFileSync(path, [
        "---",
        "from: sender",
        `timestamp: 2026-06-09T00:${minute}:00.000Z`,
        `read: ${unread ? "false" : "true"}`,
        "---",
        "",
        `message ${position}`,
      ].join("\n"));
    }

    const listed = await handler({ source: "cli", args: ["--unread", "--last", "5"] } as any);
    const displayedPosition = Number(listed.output?.match(/\n\s+(\d+)\s+/)?.[1]);
    expect(displayedPosition).toBe(45);

    const read = await handler({ source: "cli", args: ["read", String(displayedPosition)] } as any);
    expect(read.ok).toBe(true);
    expect(read.output).toContain("message 45");
    expect(readFileSync(unreadPath, "utf8")).toContain("read: true");
  });

  test("local inbox write and relative time are non-destructive and deterministic", async () => {
    await cmdInboxWrite("standalone note");
    const files = readdirSync(join(psiPath, "inbox")).filter((name) => name.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(psiPath, "inbox", files[0]), "utf8")).toContain("standalone note");
    expect(relativeTime(new Date(0))).toBe("—");
    expect(relativeTime(new Date(Date.now() + 1000))).toBe("future");
  });
});
