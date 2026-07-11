import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handlePresenceRequest, readPresenceRows } from "./route";

const dir = mkdtempSync(join(tmpdir(), "maw-presence-route-"));
const presDir = join(dir, "presence");
const prev = process.env.MAW_DATA_DIR;

const NOW = 1_700_000_000_000; // fixed clock the tests reason against
const STALE_MS = 5 * 60 * 1000;

function writePane(name: string, obj: Record<string, unknown>) {
  writeFileSync(join(presDir, name), JSON.stringify(obj));
}

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  mkdirSync(presDir, { recursive: true });
  // fresh pane — full statusline payload, stamped company (kobo-267)
  writePane("pct40.json", {
    pane: "%40", oracle: "patchwork", company: "kobo", ts: NOW - 1000,
    model: "Opus 4.8", model_id: "claude-opus-4-8", remaining_percentage: 45, used_percentage: 55,
    total_input_tokens: 90000, context_window_size: 200000,
  });
  // same oracle, second pane (crew) — remaining null, different company
  writePane("pct41.json", {
    pane: "%41", oracle: "patchwork", company: "pgw", ts: NOW - 2000,
    model: "Sonnet 4.6", remaining_percentage: null, used_percentage: 30,
  });
  // different oracle, stale (ts older than STALE_MS), UNSTAMPED (no company field)
  writePane("pct99.json", {
    pane: "%99", oracle: "eq3", ts: NOW - STALE_MS - 1000,
    model: "Opus 4.8", remaining_percentage: 80,
  });
  // garbage file — must be skipped, not throw
  writeFileSync(join(presDir, "broken.json"), "{ not json");
  // non-json file — must be ignored by the .json filter
  writeFileSync(join(presDir, "README.txt"), "ignore me");
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("readPresenceRows", () => {
  test("reads every pane file, skips garbage, marks staleness by the file's own ts", () => {
    const rows = readPresenceRows(NOW);
    expect(rows.length).toBe(3); // 3 valid panes; broken.json + README.txt dropped

    const fresh = rows.find((r) => r.pane === "%40")!;
    expect(fresh.oracle).toBe("patchwork");
    expect(fresh.model).toBe("Opus 4.8");
    expect(fresh.remaining_percentage).toBe(45);
    expect(fresh.stale).toBe(false);

    const secondPane = rows.find((r) => r.pane === "%41")!;
    expect(secondPane.oracle).toBe("patchwork"); // same oracle, distinct pane → two rows
    expect(secondPane.remaining_percentage).toBeNull(); // null carried through, not coerced to 0
    expect(secondPane.used_percentage).toBe(30);

    const stale = rows.find((r) => r.pane === "%99")!;
    expect(stale.stale).toBe(true); // ts older than the 5-min window

    expect(fresh.company).toBe("kobo"); // stamped company carried through
    expect(stale.company).toBeNull(); // unstamped file → null, not undefined
  });

  test("company filter keeps panes by ORACLE roster membership, not the file's company field (kobo-283)", () => {
    // patchwork is a kobo member → BOTH its panes show under ?company=kobo, even
    // %41 whose stale file field says "pgw". This is the kobo-283 fix: the file
    // company-stamp (kobo-267) never populated, so we join on the roster instead.
    expect(readPresenceRows(NOW, { company: "kobo", members: new Set(["patchwork"]) }).map((r) => r.pane))
      .toEqual(["%40", "%41"]);
    // eq3 is the only oracle in this company → only its pane (%99).
    expect(readPresenceRows(NOW, { company: "eq3-corp", members: new Set(["eq3"]) }).map((r) => r.pane))
      .toEqual(["%99"]);
  });

  test("a scoped row reports the QUERIED company even when its file field is unstamped/wrong (kobo-283)", () => {
    // %41's file says company "pgw", but under a kobo query (matched via roster)
    // the row must report kobo — the crux of the fix (the badge scopes correctly).
    const rows = readPresenceRows(NOW, { company: "kobo", members: new Set(["patchwork"]) });
    expect(rows.find((r) => r.pane === "%41")!.company).toBe("kobo");
  });

  test("company filter excludes an oracle not in the roster, never falls back to all (kobo-283)", () => {
    // eq3 (%99) is not a member here → a scoped query must drop it, not include it.
    expect(readPresenceRows(NOW, { company: "kobo", members: new Set(["patchwork"]) }).map((r) => r.pane))
      .not.toContain("%99");
    // zero-member company → empty, NOT the whole set.
    expect(readPresenceRows(NOW, { company: "ghost", members: new Set<string>() })).toEqual([]);
  });

  test("no company (null/undefined) → all panes, host-wide back-compat (kobo-267)", () => {
    expect(readPresenceRows(NOW, { company: null }).length).toBe(3);
    expect(readPresenceRows(NOW).length).toBe(3);
  });

  test("company + alive filters compose (kobo-283)", () => {
    // both patchwork panes are members; the alive set narrows to the live one.
    expect(readPresenceRows(NOW, { company: "kobo", members: new Set(["patchwork"]), alive: new Set(["%40"]) }).map((r) => r.pane))
      .toEqual(["%40"]);
    expect(readPresenceRows(NOW, { company: "kobo", members: new Set(["patchwork"]), alive: new Set(["%99"]) }))
      .toEqual([]); // %99 is eq3 (not a member) → membership drops it even though alive
  });

  test("alive filter drops panes whose id is not in the live tmux set (kobo-266)", () => {
    // %40 + %41 alive, %99 is a dead pane whose file still lingers → dropped.
    const rows = readPresenceRows(NOW, { alive: new Set(["%40", "%41"]) });
    expect(rows.map((r) => r.pane).sort()).toEqual(["%40", "%41"]);
    expect(rows.find((r) => r.pane === "%99")).toBeUndefined();
  });

  test("alive=null (tmux unavailable) fails open — every pane kept", () => {
    // both the explicit null and the default (no opts) must skip the filter so a
    // tmux failure never blanks the board.
    expect(readPresenceRows(NOW, { alive: null }).length).toBe(3);
    expect(readPresenceRows(NOW).length).toBe(3);
  });

  test("empty alive set (no live panes) drops all rows, does not fail open", () => {
    expect(readPresenceRows(NOW, { alive: new Set() })).toEqual([]);
  });

  test("ts=0 (never captured a real timestamp) counts as stale", () => {
    writePane("pctzero.json", { pane: "%7", oracle: "x", ts: 0, model: "m" });
    const row = readPresenceRows(NOW).find((r) => r.pane === "%7")!;
    expect(row.stale).toBe(true);
    rmSync(join(presDir, "pctzero.json"));
  });

  test("missing presence dir → empty rows, never throws", () => {
    const savedDir = process.env.MAW_DATA_DIR;
    process.env.MAW_DATA_DIR = join(dir, "does-not-exist");
    expect(readPresenceRows(NOW)).toEqual([]);
    process.env.MAW_DATA_DIR = savedDir;
  });
});

describe("handlePresenceRequest", () => {
  test("returns { rows } in the contract shape", async () => {
    const body = (await handlePresenceRequest(new Request("http://x/api/presence")).json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(body.rows)).toBe(true);
    for (const r of body.rows) {
      expect(typeof r.pane).toBe("string");
      expect("oracle" in r && "model" in r).toBe(true);
      expect("remaining_percentage" in r && "used_percentage" in r).toBe(true);
      expect(typeof r.stale).toBe("boolean");
      expect(typeof r.ts).toBe("number");
    }
  });
});
