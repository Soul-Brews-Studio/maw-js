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
let ghqRepos: Record<string, string> = {};
let fleetEntries: Array<{ session?: { windows?: Array<{ name: string; repo: string }> } }> = [];

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

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async (pattern: string) => {
    const normalized = pattern.replace(/^\//, "").replace(/\$$/, "");
    return ghqRepos[normalized] ?? null;
  },
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleetEntries: () => fleetEntries,
}));

const { resolveInboxDir, writeInboxFile, loadInboxMessages, cmdInboxLs, relativeTime, cmdInboxMarkRead, cmdInboxRead, cmdInboxWrite, parseInboxFilenameTimestamp, getInboxStatus, getAllInboxStatuses, formatInboxStatus, formatInboxStatusList, cmdInboxStatus, cmdInboxDrain, formatInboxDrainResult, oracleNameFromFleetWindow, resolvePendingId, cmdQueueList, formatQueueList, formatQueueDetail, cmdApprove, cmdReject, cmdShow, loadPending, savePending, loadPendingById, updatePending, deletePending } =
  await import("../../src/vendor/mpr-plugins/inbox/impl");

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "maw-inbox-coverage-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalStateDir = process.env.MAW_STATE_DIR;
  process.env.MAW_CONFIG_DIR = rootDir;
  process.env.MAW_STATE_DIR = join(rootDir, "state");
  psiPath = rootDir;
  ghqRepos = {};
  fleetEntries = [];
  commSendCalls.length = 0;
});

function inboxFilenameAt(ms: number, suffix: string): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    "-",
    pad(d.getMonth() + 1),
    "-",
    pad(d.getDate()),
    "_",
    pad(d.getHours()),
    "-",
    pad(d.getMinutes()),
    "_",
    suffix,
    ".md",
  ].join("");
}

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

  test("parses status timestamps from inbox filenames only", () => {
    expect(parseInboxFilenameTimestamp("2026-05-21_09-30_alpha_subject.md")?.toISOString()).toContain("2026-05-21T");
    expect(parseInboxFilenameTimestamp("no-timestamp.md")).toBeNull();
  });

  test("reports red inbox backpressure and writes a cursor", async () => {
    const now = Date.now();
    const inbox = join(rootDir, "inbox");
    const processed = join(inbox, "processed", "2026-05-21");
    mkdirSync(processed, { recursive: true });
    writeFileSync(join(inbox, inboxFilenameAt(now - 5 * 60 * 60_000, "oldest.md")), "old");
    writeFileSync(join(inbox, inboxFilenameAt(now - 10 * 60_000, "newest.md")), "new");
    writeFileSync(join(inbox, "processed-should-not-count.md"), "top-level unread");
    const archived = join(processed, "archived.md");
    writeFileSync(archived, "archived");
    const archiveTime = new Date(now - 9 * 60 * 60_000);
    utimesSync(archived, archiveTime, archiveTime);

    const status = await getInboxStatus(undefined, now);

    expect(status).toMatchObject({
      oracle: "node-oracle",
      unread: 3,
      delta_since_last_check: 0,
      level: "red",
    });
    expect(status.oldest_age_seconds).toBeGreaterThanOrEqual(5 * 60 * 60 - 60);
    expect(status.last_archive_age_seconds).toBeGreaterThanOrEqual(9 * 60 * 60 - 1);
    expect(status.reasons).toEqual(["oldest>4h", "since_archive>8h"]);
    expect(readFileSync(join(rootDir, "state", "inbox-cursor.json"), "utf-8")).toContain(`"unread": 3`);
    expect(formatInboxStatus(status)).toContain("🔴 UNREAD 3");
  });

  test("marks growing unread with no archive activity as red delta", async () => {
    const now = Date.now();
    const inbox = join(rootDir, "inbox");
    const processed = join(inbox, "processed", "2026-05-21");
    mkdirSync(processed, { recursive: true });
    writeFileSync(join(inbox, inboxFilenameAt(now - 10 * 60_000, "one.md")), "one");
    const archived = join(processed, "archived.md");
    writeFileSync(archived, "archived");
    const archiveTime = new Date(now - 60 * 60_000);
    utimesSync(archived, archiveTime, archiveTime);

    const first = await getInboxStatus(undefined, now);
    expect(first.level).toBe("green");
    expect(first.delta_since_last_check).toBe(0);

    writeFileSync(join(inbox, inboxFilenameAt(now - 5 * 60_000, "two.md")), "two");
    const second = await getInboxStatus(undefined, now + 60_000);
    expect(second.delta_since_last_check).toBe(1);
    expect(second.level).toBe("red");
    expect(second.reasons).toContain("delta>0_no_archive_activity");
  });

  test("defaults status to the parent oracle when invoked from an agents subdirectory", async () => {
    psiPath = undefined;
    const repo = join(rootDir, "sample-oracle.wt-1-agent2");
    const inbox = join(repo, "ψ", "inbox");
    const agentDir = join(repo, "agents", "agent-a");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(inbox, "2026-05-21_09-30_agent_note.md"), "note");
    process.chdir(agentDir);

    const status = await getInboxStatus(undefined, Date.parse("2026-05-21T10:00:00"));

    expect(status).toMatchObject({ oracle: "sample-oracle", unread: 1 });
  });

  test("resolves a legacy .wt cwd to the canonical repo psi inbox fallback", async () => {
    psiPath = undefined;
    const canonicalRepo = join(rootDir, "legacy-oracle");
    const worktree = join(rootDir, "legacy-oracle.wt-agent2");
    const inbox = join(canonicalRepo, "psi", "inbox");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(inbox, "2026-05-21_09-30_agent_note.md"), "legacy fallback");
    process.chdir(worktree);

    const status = await getInboxStatus(undefined, Date.parse("2026-05-21T10:00:00"));

    expect(status).toMatchObject({ oracle: "legacy-oracle", unread: 1 });
  });

  test("falls back to the current directory inbox when no own repo target resolves", async () => {
    psiPath = undefined;
    const looseCwd = join(rootDir, "loose-cwd");
    const inbox = join(looseCwd, "ψ", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "2026-05-21_09-30_agent_note.md"), "local fallback");
    process.chdir(looseCwd);

    const status = await getInboxStatus(undefined, Date.parse("2026-05-21T10:00:00"));

    expect(status.unread).toBe(1);
    expect(status.reasons).toEqual(["no_archive"]);
  });

  test("uses named oracle repo resolution and prints json status", async () => {
    const repo = join(rootDir, "named-oracle");
    const inbox = join(repo, "ψ", "inbox");
    mkdirSync(inbox, { recursive: true });
    ghqRepos["named-oracle"] = repo;

    const out = captureLogs();
    const status = await cmdInboxStatus("named-oracle", { json: true });
    out.restore();

    expect(status).toMatchObject({ oracle: "named-oracle", unread: 0, level: "green" });
    expect(JSON.parse(out.logs.join("\\n"))).toMatchObject({
      oracle: "named-oracle",
      unread: 0,
      level: "green",
      reasons: [],
    });
  });

  test("reports all locally resolvable fleet inbox statuses as a json array", async () => {
    const now = Date.now();
    const redRepo = join(rootDir, "red-oracle");
    const greenRepo = join(rootDir, "green-oracle");
    mkdirSync(join(redRepo, "ψ", "inbox"), { recursive: true });
    mkdirSync(join(greenRepo, "ψ", "inbox"), { recursive: true });
    writeFileSync(join(redRepo, "ψ", "inbox", inboxFilenameAt(now - 5 * 60 * 60_000, "old.md")), "old");
    ghqRepos["Org/red-oracle"] = redRepo;
    ghqRepos["Org/green-oracle"] = greenRepo;
    fleetEntries = [
      {
        session: {
          windows: [
            { name: "red-oracle", repo: "Org/red-oracle" },
            { name: "red-oracle", repo: "Org/red-oracle" },
            { name: "green-oracle", repo: "Org/green-oracle" },
            { name: "green-alias-oracle", repo: "Org/green-oracle" },
            { name: "missing-oracle", repo: "Org/missing-oracle" },
          ],
        },
      },
    ];

    const statuses = await getAllInboxStatuses(now);

    expect(statuses.map(s => s.oracle)).toEqual(["red-oracle", "green-oracle"]);
    expect(statuses[0]).toMatchObject({
      oracle: "red-oracle",
      unread: 1,
      level: "red",
      reasons: ["oldest>4h", "no_archive"],
    });
    expect(statuses[1]).toMatchObject({ oracle: "green-oracle", unread: 0, level: "green" });
    expect(formatInboxStatusList(statuses)).toContain("🔴 red-oracle");

    const out = captureLogs();
    const returned = await cmdInboxStatus(undefined, { all: true, json: true });
    out.restore();
    expect(returned).toHaveLength(2);
    expect(JSON.parse(out.logs.join("\\n")).map((s: { oracle: string }) => s.oracle)).toEqual([
      "red-oracle",
      "green-oracle",
    ]);
  });

  test("resolves fleet window-name oracles and tie-breaks same-level statuses by oracle name", async () => {
    const zetaRepo = join(rootDir, "zeta-oracle");
    const alphaRepo = join(rootDir, "alpha-oracle");
    mkdirSync(join(zetaRepo, "ψ", "inbox"), { recursive: true });
    mkdirSync(join(alphaRepo, "ψ", "inbox"), { recursive: true });
    ghqRepos["zeta-oracle"] = zetaRepo;
    ghqRepos["alpha-oracle"] = alphaRepo;
    fleetEntries = [
      {
        session: {
          windows: [
            { name: "zeta-oracle" },
            { name: "alpha-oracle" },
          ],
        },
      },
    ];

    const statuses = await getAllInboxStatuses(Date.parse("2026-05-21T10:00:00"));

    expect(statuses.map(s => `${s.level}:${s.oracle}`)).toEqual([
      "green:alpha-oracle",
      "green:zeta-oracle",
    ]);
  });

  test("normalizes fleet windows without oracle-suffixed names or repos", () => {
    expect(oracleNameFromFleetWindow({ name: "ops", repo: "Org/plain-repo" })).toBe("ops");
    expect(oracleNameFromFleetWindow({ repo: "Org/plain-repo" })).toBe("plain-repo");
    expect(oracleNameFromFleetWindow({})).toBeNull();
  });

  test("safe drain archives only stale slice acknowledgements up to the max cap", async () => {
    const now = Date.parse("2026-05-21T12:00:00Z");
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    const oldVerified = inboxFilenameAt(now - 48 * 60 * 60_000, "mawjs_slice-1-verified.md");
    const oldShip = inboxFilenameAt(now - 36 * 60 * 60_000, "mawjscodex_local-ship.md");
    const consultation = inboxFilenameAt(now - 72 * 60 * 60_000, "xiaoer_question.md");
    const freshVerified = inboxFilenameAt(now - 60 * 60_000, "mawjs_fresh-verified.md");
    writeFileSync(join(inbox, oldVerified), "[m5:mawjs] ✅ slice 1 verified (abcdef1). CI green confirmed.");
    writeFileSync(join(inbox, oldShip), "[m5:mawjscodex_maw-rs] local ship commit 123abcd: ported a slice. Verified cargo test.");
    writeFileSync(join(inbox, consultation), "[m5:xiaoer-oracle] Nat asked: should maw brew be core? Please advise.");
    writeFileSync(join(inbox, freshVerified), "[m5:mawjs] ✅ slice 2 verified (abcdef2). CI green confirmed.");

    const dryOut = captureLogs();
    const dryRun = await cmdInboxDrain(undefined, { safe: true, dryRun: true, max: 1 }, now);
    dryOut.restore();

    expect(dryRun).toMatchObject({
      scanned: 4,
      matched: 2,
      archived: 1,
      remaining_matches: 1,
      dry_run: true,
      older_than_seconds: 4 * 60 * 60,
    });
    expect(existsSync(join(inbox, oldVerified))).toBe(true);
    expect(formatInboxDrainResult(dryRun)).toContain("would archive 1/2");

    const out = captureLogs();
    const result = await cmdInboxDrain(undefined, { safe: true, max: 1, json: true }, now);
    out.restore();

    expect(result).toMatchObject({
      scanned: 4,
      matched: 2,
      archived: 1,
      remaining_matches: 1,
      dry_run: false,
    });
    expect(JSON.parse(out.logs.join("\n"))).toMatchObject({ archived: 1, matched: 2 });
    expect(result.items[0]).toMatchObject({ filename: oldVerified, action: "archived" });
    expect(existsSync(join(inbox, oldVerified))).toBe(false);
    expect(existsSync(join(inbox, "processed", "2026-05-21", oldVerified))).toBe(true);
    expect(existsSync(join(inbox, oldShip))).toBe(true);
    expect(existsSync(join(inbox, consultation))).toBe(true);
    expect(existsSync(join(inbox, freshVerified))).toBe(true);
  });

  test("safe drain reports an empty filter for directive and non-matching bracketed messages", async () => {
    const now = Date.parse("2026-05-21T12:00:00Z");
    const inbox = join(rootDir, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, inboxFilenameAt(now - 8 * 60 * 60_000, "directive.md")),
      "[m5:mawjs] directive do not archive this shipped slice",
    );
    writeFileSync(
      join(inbox, inboxFilenameAt(now - 7 * 60 * 60_000, "plain-status.md")),
      "[m5:mawjs] routine handoff complete",
    );

    const out = captureLogs();
    const result = await cmdInboxDrain(undefined, { safe: true, dryRun: true }, now);
    out.restore();

    expect(result).toMatchObject({
      scanned: 2,
      matched: 0,
      archived: 0,
      remaining_matches: 0,
    });
    expect(result.items).toEqual([]);
    expect(out.logs.join("\n")).toContain("no messages matched the safe stale-ack filter");
  });

  test("safe drain uses frontmatter timestamps, skips null timestamps, and suffixes archive collisions", async () => {
    const now = Date.parse("2026-05-21T12:00:00Z");
    const inbox = join(rootDir, "inbox");
    const processed = join(inbox, "processed", "2026-05-21");
    mkdirSync(processed, { recursive: true });
    writeFileSync(join(processed, "frontmatter-only.md"), "already archived");
    writeFileSync(join(inbox, "frontmatter-only.md"), [
      "---",
      "from: mawjs",
      "to: node-oracle",
      "timestamp: 2026-05-20T12:00:00.000Z",
      "read: false",
      "---",
      "",
      "[m5:mawjs] ✅ batch verified",
    ].join("\n"));
    writeFileSync(join(inbox, "missing-timestamp.md"), [
      "---",
      "from: mawjs",
      "to: node-oracle",
      "timestamp: not-a-date",
      "read: false",
      "---",
      "",
      "[m5:mawjs] ✅ batch verified",
    ].join("\n"));

    const out = captureLogs();
    const result = await cmdInboxDrain(undefined, { safe: true, max: 10 }, now);
    out.restore();

    expect(result).toMatchObject({ scanned: 2, matched: 1, archived: 1 });
    expect(result.items[0]).toMatchObject({
      filename: "frontmatter-only.md",
      action: "archived",
      reason: "verified",
    });
    expect(result.items[0].destination).toBe(join(processed, "frontmatter-only-2.md"));
    expect(existsSync(join(processed, "frontmatter-only.md"))).toBe(true);
    expect(existsSync(join(processed, "frontmatter-only-2.md"))).toBe(true);
    expect(existsSync(join(inbox, "frontmatter-only.md"))).toBe(false);
    expect(existsSync(join(inbox, "missing-timestamp.md"))).toBe(true);
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
