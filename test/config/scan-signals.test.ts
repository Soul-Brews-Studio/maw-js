/**
 * Tests for src/commands/shared/scan-signals.ts — scanSignals.
 * Uses real temp directory for filesystem tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanSignals } from "../../src/commands/shared/scan-signals";

const TMP = join(tmpdir(), `maw-signals-test-${Date.now()}`);
const SIG_DIR = join(TMP, "ψ", "memory", "signals");

beforeAll(() => mkdirSync(SIG_DIR, { recursive: true }));
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

function writeSignal(name: string, signal: object) {
  writeFileSync(join(SIG_DIR, name), JSON.stringify(signal), "utf-8");
}

describe("scanSignals", () => {
  it("returns empty for missing directory", () => {
    expect(scanSignals("/nonexistent/path")).toEqual([]);
  });

  it("reads signal files", () => {
    const now = new Date().toISOString();
    writeSignal("s1.json", { type: "done", oracle: "neo", timestamp: now, message: "test" });
    const results = scanSignals(TMP);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe("done");
    expect(results[0].file).toBe("s1.json");
  });

  it("filters by days cutoff", () => {
    const old = new Date();
    old.setDate(old.getDate() - 30);
    writeSignal("old.json", { type: "done", oracle: "neo", timestamp: old.toISOString(), message: "old" });

    const recent = scanSignals(TMP, { days: 7 });
    const oldSignals = recent.filter(s => s.file === "old.json");
    expect(oldSignals).toHaveLength(0);
  });

  it("sorts newest-first", () => {
    const d1 = new Date();
    const d2 = new Date(d1.getTime() - 3600000);
    writeSignal("a-newer.json", { type: "done", oracle: "a", timestamp: d1.toISOString(), message: "newer" });
    writeSignal("b-older.json", { type: "done", oracle: "b", timestamp: d2.toISOString(), message: "older" });

    const results = scanSignals(TMP, { days: 7 });
    const newerIdx = results.findIndex(s => s.file === "a-newer.json");
    const olderIdx = results.findIndex(s => s.file === "b-older.json");
    if (newerIdx >= 0 && olderIdx >= 0) {
      expect(newerIdx).toBeLessThan(olderIdx);
    }
  });

  it("skips non-json files", () => {
    writeFileSync(join(SIG_DIR, "readme.txt"), "not json", "utf-8");
    const results = scanSignals(TMP);
    expect(results.every(s => s.file.endsWith(".json"))).toBe(true);
  });

  it("skips malformed JSON", () => {
    writeFileSync(join(SIG_DIR, "bad.json"), "not valid json {{{", "utf-8");
    // Should not throw
    const results = scanSignals(TMP);
    expect(results.every(s => s.file !== "bad.json")).toBe(true);
  });
});
