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

    await cmdInboxMarkRead("compact");
    await cmdInboxMarkRead("missing");

    expect(readFileSync(compact, "utf8")).toContain("read: true");
    expect(readFileSync(compact, "utf8")).toContain("readAt:");
    expect(readFileSync(missing, "utf8")).toContain("read: true");
    expect(readFileSync(missing, "utf8")).toContain("readAt:");
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
