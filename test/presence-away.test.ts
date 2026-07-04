import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isOracleAway } from "../src/core/worklog/presence-away";
import { appendWorklog, flushWorklog } from "../src/core/worklog/store";

// mawjs-3 — away is derived from the worklog (newest-wins), no new store.
describe("isOracleAway (presence gate read side)", () => {
  beforeEach(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "away-test-"));
  });

  const away = (oracle: string, ts: number) =>
    appendWorklog({ ts, iso: "i", oracle, kind: "away", summary: "away" });
  const activity = (oracle: string, ts: number, kind: any = "tool") =>
    appendWorklog({ ts, iso: "i", oracle, kind, summary: "x" });

  it("no events → not away", () => {
    expect(isOracleAway("zzghost")).toBe(false);
  });

  it("newest event is away → away", async () => {
    activity("zzaway", 1);
    away("zzaway", 2);
    await flushWorklog();
    expect(isOracleAway("zzaway")).toBe(true);
  });

  it("newest-wins — activity after away clears it (auto-clear on next turn)", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "conversation"); // e.g. UserPromptSubmit after /seat
    await flushWorklog();
    expect(isOracleAway("zzaway")).toBe(false);
  });

  it("newest-wins — `maw presence back` (idle) clears away", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "idle"); // maw presence back
    await flushWorklog();
    expect(isOracleAway("zzaway")).toBe(false);
  });

  it("scoped per oracle — one oracle away does not mark another", async () => {
    away("zzaway", 5);
    activity("zzother", 6);
    await flushWorklog();
    expect(isOracleAway("zzaway")).toBe(true);
    expect(isOracleAway("zzother")).toBe(false);
  });

  it("empty / whitespace oracle → not away (no crash)", () => {
    expect(isOracleAway("")).toBe(false);
    expect(isOracleAway(null)).toBe(false);
  });
});
