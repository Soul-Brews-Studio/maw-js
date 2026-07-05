import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPaneAway } from "../src/core/worklog/presence-away";
import { appendWorklog, flushWorklog } from "../src/core/worklog/store";

// mawjs-3 / kobo-120 — away is derived from the worklog (newest-wins per pane), no new store.
describe("isPaneAway (presence gate read side)", () => {
  beforeEach(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "away-test-"));
  });

  const away = (oracle: string, ts: number, paneId?: string) =>
    appendWorklog({ ts, iso: "i", oracle, kind: "away", summary: "away", ...(paneId ? { paneId } : {}) });
  const activity = (oracle: string, ts: number, kind: any = "tool", paneId?: string) =>
    appendWorklog({ ts, iso: "i", oracle, kind, summary: "x", ...(paneId ? { paneId } : {}) });

  it("no events → not away", () => {
    expect(isPaneAway("zzghost", undefined)).toBe(false);
  });

  it("newest event is away → away (oracle-level, no paneId)", async () => {
    activity("zzaway", 1);
    away("zzaway", 2);
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
  });

  it("newest-wins — real activity (conversation) after away clears it", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "conversation"); // operator came back and typed
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(false);
  });

  it("STICKY — idle (CC Stop) after away does NOT clear it (kobo-120)", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "idle"); // transparent turn-end
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
  });

  it("STICKY — error turn-end after away does NOT clear it", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "error");
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
  });

  it("`maw presence back` (kind:back) clears away", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "back"); // deliberate return
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(false);
  });

  it("PER-PANE — coord pane away + worker pane active (same oracle)", async () => {
    away("zzcrew", 1, "%52"); // coord stepped out
    activity("zzcrew", 2, "tool", "%53"); // worker still working
    await flushWorklog();
    expect(isPaneAway("zzcrew", "%52")).toBe(true); // hey→coord pane parks
    expect(isPaneAway("zzcrew", "%53")).toBe(false); // hey→worker pane injects
  });

  it("PER-PANE — worker idle does not clear coord's away", async () => {
    away("zzcrew", 1, "%52");
    activity("zzcrew", 2, "idle", "%53"); // worker's turn ended
    activity("zzcrew", 3, "idle", "%52"); // coord pane also idled (still away)
    await flushWorklog();
    expect(isPaneAway("zzcrew", "%52")).toBe(true);
  });

  it("scoped per oracle — one oracle away does not mark another", async () => {
    away("zzaway", 5);
    activity("zzother", 6);
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
    expect(isPaneAway("zzother", undefined)).toBe(false);
  });

  it("empty / whitespace oracle → not away (no crash)", () => {
    expect(isPaneAway("", undefined)).toBe(false);
    expect(isPaneAway(null, undefined)).toBe(false);
  });
});
