/**
 * bud-signal.test.ts — writeSignal + scanSignals coverage (#209 slice γ-B)
 *
 * Why isolated: leaf.ts and scan-signals.ts both touch real fs paths. We
 * redirect all writes to per-run mkdtempSync dirs — same rationale as
 * bud-init.test.ts ("mock only what touches destructive outside state").
 * No mock.module needed here because neither module reads process.env paths
 * at import time.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpBase = mkdtempSync(join(tmpdir(), "maw-bud-signal-"));

afterAll(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

const { writeSignal } = await import("../../src/core/fleet/leaf");
const { scanSignals } = await import("../../src/commands/shared/scan-signals");

// ─── helpers ────────────────────────────────────────────────────────────────

function freshRoot(): string {
  return mkdtempSync(join(tmpBase, "oracle-"));
}

function writeOldSignal(root: string, bud: string, daysAgo: number): void {
  const dir = join(root, "ψ", "memory", "signals");
  mkdirSync(dir, { recursive: true });
  const ts = new Date();
  ts.setDate(ts.getDate() - daysAgo);
  const signal = { timestamp: ts.toISOString(), bud, kind: "info", message: `${daysAgo}d old` };
  const date = ts.toISOString().slice(0, 10);
  writeFileSync(join(dir, `${date}_${bud}_${daysAgo}d-old.json`), JSON.stringify(signal));
}

// ─── writeSignal ────────────────────────────────────────────────────────────

describe("writeSignal — file creation (#209)", () => {
  test("creates signals dir and returns the file path", () => {
    const root = freshRoot();
    const filePath = writeSignal(root, "alpha", { kind: "info", message: "birth" });
    expect(existsSync(filePath)).toBe(true);
  });

  test("written JSON has all required Signal fields", () => {
    const root = freshRoot();
    const filePath = writeSignal(root, "alpha", { kind: "info", message: "birth" });
    const signal = JSON.parse(require("fs").readFileSync(filePath, "utf-8"));
    expect(signal.bud).toBe("alpha");
    expect(signal.kind).toBe("info");
    expect(signal.message).toBe("birth");
    expect(signal.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("filename matches YYYY-MM-DD_<bud>_<slug>.json pattern", () => {
    const root = freshRoot();
    const filePath = writeSignal(root, "beta", { kind: "alert", message: "memory threshold exceeded" });
    const filename = filePath.split("/").pop()!;
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}_beta_memory-threshold-exceeded\.json$/);
  });

  test("stores context when provided", () => {
    const root = freshRoot();
    const filePath = writeSignal(root, "gamma", {
      kind: "pattern",
      message: "pattern detected",
      context: { count: 3, label: "test" },
    });
    const signal = JSON.parse(require("fs").readFileSync(filePath, "utf-8"));
    expect(signal.context).toEqual({ count: 3, label: "test" });
  });

  test("omits context field when not provided", () => {
    const root = freshRoot();
    const filePath = writeSignal(root, "delta", { kind: "info", message: "no ctx" });
    const signal = JSON.parse(require("fs").readFileSync(filePath, "utf-8"));
    expect(signal.context).toBeUndefined();
  });

  test("writes inside <root>/ψ/memory/signals/", () => {
    const root = freshRoot();
    const filePath = writeSignal(root, "epsilon", { kind: "info", message: "loc test" });
    expect(filePath).toContain(join(root, "ψ", "memory", "signals"));
  });

  test("two distinct messages produce two files", () => {
    const root = freshRoot();
    writeSignal(root, "zeta", { kind: "info", message: "first message here" });
    writeSignal(root, "zeta", { kind: "info", message: "second message here" });
    const files = readdirSync(join(root, "ψ", "memory", "signals"));
    expect(files.length).toBe(2);
  });

  test("all three kinds are accepted: info, alert, pattern", () => {
    const root = freshRoot();
    for (const kind of ["info", "alert", "pattern"] as const) {
      const fp = writeSignal(root, "kindtest", { kind, message: `${kind} msg` });
      const sig = JSON.parse(require("fs").readFileSync(fp, "utf-8"));
      expect(sig.kind).toBe(kind);
    }
  });
});

// ─── scanSignals ────────────────────────────────────────────────────────────

describe("scanSignals — recency filter (#209)", () => {
  test("returns empty array when signals dir does not exist", () => {
    const root = freshRoot();
    expect(scanSignals(root)).toEqual([]);
  });

  test("returns a just-written signal within default 7d window", () => {
    const root = freshRoot();
    writeSignal(root, "alpha", { kind: "info", message: "recent" });
    const results = scanSignals(root, { days: 7 });
    expect(results.length).toBe(1);
    expect(results[0].bud).toBe("alpha");
    expect(results[0].file).toBeDefined();
  });

  test("filters out signals older than the cutoff", () => {
    const root = freshRoot();
    writeOldSignal(root, "old", 30);
    expect(scanSignals(root, { days: 7 }).length).toBe(0);
  });

  test("respects custom days window — 10d signal excluded at days=7, included at days=14", () => {
    const root = freshRoot();
    writeOldSignal(root, "tenday", 10);
    expect(scanSignals(root, { days: 7 }).length).toBe(0);
    expect(scanSignals(root, { days: 14 }).length).toBe(1);
  });

  test("returns results sorted newest-first", () => {
    const root = freshRoot();
    // Write a signal with a later timestamp directly
    const dir = join(root, "ψ", "memory", "signals");
    mkdirSync(dir, { recursive: true });
    const laterTs = new Date(Date.now() + 1000).toISOString();
    const later = { timestamp: laterTs, bud: "second", kind: "info", message: "newer" };
    writeFileSync(join(dir, `${laterTs.slice(0, 10)}_second_newer.json`), JSON.stringify(later));
    writeSignal(root, "first", { kind: "info", message: "older message" });
    const results = scanSignals(root, { days: 7 });
    expect(results[0].bud).toBe("second");
  });

  test("skips non-JSON files in signals dir", () => {
    const root = freshRoot();
    const dir = join(root, "ψ", "memory", "signals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# signals");
    writeSignal(root, "alpha", { kind: "info", message: "real signal" });
    const results = scanSignals(root);
    expect(results.length).toBe(1);
    expect(results[0].bud).toBe("alpha");
  });

  test("skips malformed JSON files without throwing", () => {
    const root = freshRoot();
    const dir = join(root, "ψ", "memory", "signals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01_bad_corrupt.json"), "{ broken json");
    writeSignal(root, "good", { kind: "info", message: "valid" });
    const results = scanSignals(root);
    expect(results.length).toBe(1);
    expect(results[0].bud).toBe("good");
  });
});
