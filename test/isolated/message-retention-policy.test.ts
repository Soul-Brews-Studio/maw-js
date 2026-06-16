import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-message-retention-"));
const oldHome = process.env.MAW_HOME;
process.env.MAW_HOME = SANDBOX;
process.env.MAW_TEST_MODE = "1";

const { pruneJsonlFile, resolveMessageRetentionPolicy } = await import("../../src/vendor/mpr-plugins/messages/retention.ts?retention-policy");
const ledger = await import("../../src/vendor/mpr-plugins/messages/ledger.ts?retention-policy");

beforeEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  delete process.env.MAW_MESSAGE_KEEP_LAST;
  delete process.env.MAW_MESSAGE_MAX_AGE_DAYS;
});

afterAll(() => {
  if (oldHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = oldHome;
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("message retention policy (#2165)", () => {
  test("pruneJsonlFile trims by keep-last and max-age", () => {
    const file = join(SANDBOX, "inbox.jsonl");
    writeFileSync(file, [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", msg: "old" }),
      JSON.stringify({ ts: "2026-01-10T00:00:00.000Z", msg: "mid" }),
      JSON.stringify({ ts: "2026-01-20T00:00:00.000Z", msg: "new" }),
      "",
    ].join("\n"));

    const summary = pruneJsonlFile(file, { keepLast: 2, maxAgeDays: 15, now: new Date("2026-01-21T00:00:00.000Z") });

    expect(summary).toMatchObject({ retained: 2, removed: 1, policy: { keepLast: 2, maxAgeDays: 15 } });
    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain("old");
    expect(text).toContain("mid");
    expect(text).toContain("new");
  });

  test("keep-last preserves newest records even when age expired", () => {
    const file = join(SANDBOX, "inbox-old-newest.jsonl");
    writeFileSync(file, [
      JSON.stringify({ ts: "2025-12-01T00:00:00.000Z", msg: "ancient" }),
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", msg: "newer-but-expired" }),
      "",
    ].join("\n"));

    const summary = pruneJsonlFile(file, { keepLast: 1, maxAgeDays: 1, now: new Date("2026-01-21T00:00:00.000Z") });

    expect(summary).toMatchObject({ retained: 1, removed: 1 });
    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain("ancient");
    expect(text).toContain("newer-but-expired");
  });

  test("env config drives retention defaults", () => {
    process.env.MAW_MESSAGE_KEEP_LAST = "4";
    process.env.MAW_MESSAGE_MAX_AGE_DAYS = "8";
    expect(resolveMessageRetentionPolicy()).toEqual({ keepLast: 4, maxAgeDays: 8 });
  });

  test("pruneMessageLedgerEvents bounds sqlite rows", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, ts TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, channel TEXT NOT NULL, route TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, target TEXT, peer_url TEXT, text TEXT NOT NULL, error TEXT, last_line TEXT, signed INTEGER NOT NULL DEFAULT 0)");
    const insert = db.query("INSERT INTO messages (id, ts, direction, state, channel, route, from_id, to_id, text) VALUES ($id, $ts, 'outbound', 'sent', 'maw', 'local', 'a', 'b', 'hello')");
    insert.run({ $id: "old", $ts: "2026-01-01T00:00:00.000Z" });
    insert.run({ $id: "mid", $ts: "2026-01-10T00:00:00.000Z" });
    insert.run({ $id: "new", $ts: "2026-01-20T00:00:00.000Z" });

    const summary = ledger.pruneMessageLedgerEvents({ keepLast: 2, maxAgeDays: 30, now: new Date("2026-01-21T00:00:00.000Z") }, db);

    expect(summary).toMatchObject({ retained: 2, removed: 1, policy: { keepLast: 2, maxAgeDays: 30 } });
    expect(db.query("SELECT id FROM messages ORDER BY ts").all().map((r: any) => r.id)).toEqual(["mid", "new"]);
    db.close();
  });
});
