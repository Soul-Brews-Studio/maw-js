import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _resetWorklogMigrationMemo,
  appendWorklog,
  readWorklog,
  worklogPath,
} from "./store";
import type { WorklogEntry } from "./types";

// Track 2 — worklog moved to ~/.maw/companies/<c>/worklog.jsonl. These pin the
// zero-loss auto-migration (rename old→new) + read fallback.

const dir = mkdtempSync(join(tmpdir(), "maw-wlmig-"));
const prev = process.env.MAW_DATA_DIR;

const legacyPath = (c: string) => join(dir, "worklog", `${c}.jsonl`);
const newPath = (c: string) => join(dir, "companies", c, "worklog.jsonl");

function seedLegacy(company: string, lines: WorklogEntry[]): void {
  mkdirSync(join(dir, "worklog"), { recursive: true });
  writeFileSync(legacyPath(company), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function entry(company: string, summary: string, ts: number): WorklogEntry {
  return { ts, iso: new Date(ts).toISOString(), oracle: "x", company, kind: "tool", summary };
}

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(dir, "worklog"), { recursive: true, force: true });
  rmSync(join(dir, "companies"), { recursive: true, force: true });
  _resetWorklogMigrationMemo();
});

describe("worklog Company-Home migration (Track 2)", () => {
  test("worklogPath points at the Company Home", () => {
    expect(worklogPath("pgw")).toBe(newPath("pgw"));
    expect(worklogPath(null)).toBe(newPath("_unscoped")); // _unscoped covered
  });

  test("read auto-migrates legacy → new (rename), zero loss (count before == after)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => entry("kobo", `e${i}`, 1000 + i));
    seedLegacy("kobo", lines);
    const before = readFileSync(legacyPath("kobo"), "utf-8").trimEnd().split("\n").length;
    const read = readWorklog("kobo");
    expect(read.length).toBe(50);
    expect(existsSync(newPath("kobo"))).toBe(true); // moved to new home
    expect(existsSync(legacyPath("kobo"))).toBe(false); // old gone (rename, not copy)
    const after = readFileSync(newPath("kobo"), "utf-8").trimEnd().split("\n").length;
    expect(after).toBe(before); // not one line lost
  });

  test("append auto-migrates then adds — legacy history preserved", () => {
    seedLegacy("pgw", [entry("pgw", "old-1", 1), entry("pgw", "old-2", 2)]);
    appendWorklog(entry("pgw", "new-3", 3));
    const all = readWorklog("pgw");
    expect(all.map((e) => e.summary)).toEqual(["old-1", "old-2", "new-3"]);
    expect(existsSync(legacyPath("pgw"))).toBe(false);
  });

  test("idempotent — when new already exists, legacy is left untouched (no clobber)", () => {
    // new home already has data; a stale legacy file must NOT overwrite it
    mkdirSync(join(dir, "companies", "pgw"), { recursive: true });
    writeFileSync(newPath("pgw"), JSON.stringify(entry("pgw", "canonical", 9)) + "\n");
    seedLegacy("pgw", [entry("pgw", "STALE", 1)]);
    const all = readWorklog("pgw");
    expect(all.map((e) => e.summary)).toEqual(["canonical"]); // new wins, stale ignored
    expect(existsSync(legacyPath("pgw"))).toBe(true); // legacy not consumed
  });

  test("fresh company (no legacy) — append creates the new file directly", () => {
    appendWorklog(entry("newco", "first", 1));
    expect(existsSync(newPath("newco"))).toBe(true);
    expect(readWorklog("newco").map((e) => e.summary)).toEqual(["first"]);
  });

  test("concurrent appends across the migration boundary keep every line", () => {
    seedLegacy("kobo", [entry("kobo", "old", 1)]);
    // first append triggers the migration; a burst right after must all land
    for (let i = 0; i < 10; i++) appendWorklog(entry("kobo", `burst${i}`, 100 + i));
    const summaries = readWorklog("kobo").map((e) => e.summary);
    expect(summaries.length).toBe(11); // 1 legacy + 10 burst, none lost
    expect(summaries[0]).toBe("old");
  });

  test("read fallback returns [] for a company that never existed", () => {
    expect(readWorklog("ghost")).toEqual([]);
  });
});
