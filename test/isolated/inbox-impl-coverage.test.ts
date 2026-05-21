import {
  beforeEach,
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let rootDir: string;
let originalConfigDir: string | undefined;
let originalStateDir: string | undefined;

const commSendCalls: Array<{ query: string; message: string }> = [];
let psiPath: string | undefined = "";
const originalCwd = process.cwd();

function captureLogs() {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: any[]) => logs.push(args.join(" "));
  console.error = (...args: any[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ ...(psiPath === undefined ? {} : { psiPath }), node: "m5", oracle: "node-oracle" }),
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  cmdSend: async (query: string, message: string) => {
    commSendCalls.push({ query, message });
  },
}));

const { resolveInboxDir, writeInboxFile, loadInboxMessages, cmdInboxLs, relativeTime, cmdInboxMarkRead, cmdInboxRead, cmdInboxWrite, resolvePendingId, cmdQueueList, formatQueueList, formatQueueDetail, cmdApprove, cmdReject, cmdShow, loadPending, savePending, loadPendingById, updatePending, deletePending } =
  await import("../../src/vendor/mpr-plugins/inbox/impl");

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "maw-inbox-coverage-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalStateDir = process.env.MAW_STATE_DIR;
  process.env.MAW_CONFIG_DIR = rootDir;
  process.env.MAW_STATE_DIR = join(rootDir, "state");
  psiPath = rootDir;
  commSendCalls.length = 0;
});

describe("inbox impl utility surface", () => {
  test("resolves inbox directory using psiPath, local ψ, and psi fallback", () => {
    expect(resolveInboxDir()).toBe(join(rootDir, "inbox"));

    psiPath = undefined;
    process.chdir(rootDir);
    mkdirSync(join(rootDir, "ψ", "inbox"), { recursive: true });
    expect(realpathSync(resolveInboxDir())).toBe(realpathSync(join(rootDir, "ψ", "inbox")));

    rmSync(join(rootDir, "ψ"), { recursive: true, force: true });
    expect(resolveInboxDir()).toBe(join(process.cwd(), "psi", "inbox"));
  });

  test("writes inbox files with parsed frontmatter and safe filename slug", () => {
    const inbox = join(rootDir, "inbox");
    const filename = writeInboxFile(inbox, "alpha", "beta", "hello from the dark side");
    const path = join(inbox, filename);

    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("from: alpha");
    expect(body).toContain("to: beta");
    expect(body).toContain("read: false");
    expect(body).toContain("hello from the dark side");
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_alpha_hello-from-the-dark-side\.md$/);
  });

  test("loads and sorts inbox messages newest-first with fm, filename, and mtime fallbacks", () => {
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const older = join(inbox, "2025-12-31_23-58_x-y_no-fm.md");
    writeFileSync(older, "legacy body");
    const withFm = join(inbox, "2026-01-01_00-00_a_b_with-fm.md");
    writeFileSync(withFm, [
      "---",
      "from: alice",
      "to: bob",
      "timestamp: 2026-01-01T00:00:00.000Z",
      "read: false",
      "---",
      "",
      "from fm body",
    ].join("\n"));
    const invalidFm = join(inbox, "2026-01-02_00-01_c_d_invalid-fm.md");
    writeFileSync(invalidFm, [
      "---",
      "from: charlie",
      "to: dave",
      "timestamp: not-a-date",
      "read: false",
      "---",
      "",
      "fallback from filename",
    ].join("\n"));

    const undated = join(inbox, "undated.md");
    writeFileSync(undated, "undated body");
    const mtime = new Date("2026-01-03T00:02:00.000Z");
    utimesSync(undated, mtime, mtime);

    const msgs = loadInboxMessages(inbox);
    expect(msgs.map(m => m.filename)).toHaveLength(4);
    expect(msgs[0].filename).toBe("undated.md");
    expect(msgs[1].frontmatter.from).toBe("charlie");
    expect(msgs[2].frontmatter.from).toBe("alice");
    expect(msgs[3].frontmatter.from).toBe("unknown");
  });

  test("formats relative time buckets defensively", () => {
    expect(relativeTime(new Date(Date.now() - 20_000))).toBe("just now");
    expect(relativeTime(new Date(Date.now() - 11 * 60_000))).toBe("11m ago");
    expect(relativeTime(new Date(Date.now() - 4 * 60 * 60_000))).toBe("4h ago");
    expect(relativeTime(new Date(Date.now() - 10 * 24 * 60 * 60_000))).toBe("10d ago");
    expect(relativeTime(new Date("1970-01-01T00:00:00.000Z"))).toBe("—");
    expect(relativeTime(new Date(Date.now() + 60_000))).toBe("future");
  });

  test("ls command filters unread/from/limit and prints empty state", async () => {
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "2026-01-01_00-00_a_a.md"), [
      "---", "from: alpha", "to: beta", "timestamp: 2026-01-01T00:00:00.000Z", "read: true", "---", "", "alpha old", "",
    ].join("\n"));
    writeFileSync(join(inbox, "2026-01-01_00-01_a_b.md"), [
      "---", "from: beta", "to: alpha", "timestamp: 2026-01-01T00:01:00.000Z", "read: false", "---", "", "beta new", "",
    ].join("\n"));

    const once = captureLogs();
    await cmdInboxLs({ unread: true, from: "beta", last: 1 });
    once.restore();
    expect(once.logs.join("\\n")).toContain("INBOX");
    expect(once.logs.join("\\n")).toContain("beta");

    const none = captureLogs();
    process.env.MAW_TEST_MODE = "1";
    await cmdInboxLs({ unread: true, from: "gamma" });
    delete process.env.MAW_TEST_MODE;
    none.restore();
    expect(none.logs.join("\\n")).toContain("no inbox messages");
  });

  test("marks messages read and handles already-read/not-found paths", async () => {
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const filename = writeInboxFile(inbox, "agent", "target", "read me now");
    const id = filename.replace(/\\.md$/, "");

    const first = captureLogs();
    await cmdInboxMarkRead("missing");
    first.restore();
    expect(first.errors.join("\\n")).toContain("message not found");

    const second = captureLogs();
    await cmdInboxMarkRead(id);
    second.restore();
    const after = readFileSync(join(inbox, filename), "utf-8");
    expect(after).toContain("read: true");

    const third = captureLogs();
    await cmdInboxMarkRead(id);
    third.restore();
    expect(third.logs.join("\\n")).toContain("already read");
  });

  test("reads messages by index and id substring", async () => {
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const older = writeInboxFile(inbox, "beta", "alpha", "older");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latest = writeInboxFile(inbox, "alpha", "beta", "most recent");

    const out = captureLogs();
    await cmdInboxRead();
    out.restore();
    expect(out.logs.join("\\n")).toContain(latest);

    const out2 = captureLogs();
    await cmdInboxRead("1");
    out2.restore();
    expect(out2.logs.join("\\n")).toContain("most recent");

    const out3 = captureLogs();
    await cmdInboxRead("ghost-id");
    out3.restore();
    expect(out3.errors.join("\\n")).toContain("not found");
  });

  test("writes inbound notes and errors when inbox missing", async () => {
    const outMissing = captureLogs();
    await cmdInboxWrite("orphan");
    outMissing.restore();
    expect(outMissing.errors.join("\\n")).toContain("inbox not found");

    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const outOk = captureLogs();
    await cmdInboxWrite("persisted note");
    outOk.restore();
    expect(outOk.logs.join("\\n")).toContain("wrote");
  });
});

describe("inbox impl queue helpers", () => {
  beforeEach(() => {
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    // keep queue-store sandboxed per test
    process.env.MAW_TEST_MODE = "1";
  });

  test("resolvePendingId uses exact and prefix semantics", async () => {
    const a = savePending({ sender: "x", target: "y", message: "first" });
    const b = savePending({ sender: "x", target: "z", message: "second" });
    expect(resolvePendingId(a.id)?.id).toBe(a.id);
    expect(resolvePendingId(b.id.slice(0, 30))?.id).toBe(b.id);
    expect(resolvePendingId("does-not-exist")).toBeNull();
  });

  test("queue list and format helpers include only pending rows and produce stable text", async () => {
    const p1 = savePending({ sender: "a", target: "b", message: "hello one" });
    updatePending(p1.id, { status: "approved" });
    const p2 = savePending({ sender: "a", target: "c", message: "hello two" });
    const list = cmdQueueList();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(p2.id);

    const text = formatQueueList(list);
    expect(text).toContain("sender");
    expect(text).toContain(p2.id);
    expect(formatQueueDetail(p2)).toContain("message:");
  });

  test("approve rejects non-pending queued messages", async () => {
    const pending = savePending({ sender: "a", target: "b", message: "already approved" });
    updatePending(pending.id, { status: "approved" });

    await expect(cmdApprove(pending.id)).rejects.toThrow("already approved");
    expect(commSendCalls).toEqual([]);
  });

  test("approve sets pending to approved, calls send with bypass, then deletes", async () => {
    const pending = savePending({ sender: "a", target: "b", message: "send-now" });
    const approved = await cmdApprove(pending.id);
    expect(approved.status).toBe("approved");
    expect(commSendCalls).toEqual([{ query: approved.target, message: pending.message }]);
    expect(loadPendingById(approved.id)).toBeNull();
  });

  test("reject marks pending messages rejected, deletes them, and is idempotent", async () => {
    const pending = savePending({ sender: "a", target: "b", message: "x" });
    const rejected = cmdReject(pending.id);
    expect(rejected.status).toBe("rejected");
    expect(loadPendingById(pending.id)).toBeNull();

    const pendingAgain = savePending({ sender: "a", target: "b", message: "x" });
    const preRejected = updatePending(pendingAgain.id, { status: "rejected" });
    const one = cmdReject(preRejected.id);
    expect(one.status).toBe("rejected");
    expect(loadPendingById(preRejected.id)).toBeNull();
  });

  test("show returns null for unknown prefix and message for known", () => {
    const pending = savePending({ sender: "s", target: "t", message: "visible" });
    expect(cmdShow(pending.id)).toBeTruthy();
    expect(cmdShow("nope")).toBeNull();
    deletePending(pending.id);
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) {
    delete process.env.MAW_CONFIG_DIR;
  } else {
    process.env.MAW_CONFIG_DIR = originalConfigDir;
  }
  if (originalStateDir === undefined) {
    delete process.env.MAW_STATE_DIR;
  } else {
    process.env.MAW_STATE_DIR = originalStateDir;
  }
  delete process.env.MAW_TEST_MODE;
  try {
    rmSync(rootDir, { recursive: true, force: true });
  } catch { /* cleanup best-effort */ }
});
