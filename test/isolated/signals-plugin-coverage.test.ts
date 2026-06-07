/** Isolated coverage for src/vendor/mpr-plugins/signals/index.ts. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpBase = mkdtempSync(join(tmpdir(), "maw-signals-plugin-coverage-"));
const originalCwd = process.cwd();

type FakeSignal = {
  timestamp: string;
  bud: string;
  kind: string;
  message: string;
  file: string;
};

type ScanCall = { root: string; opts: { days?: number } };

let fakeSignals: FakeSignal[] = [];
let fakeError: Error | null = null;
let emitScanWarning = false;
let scanCalls: ScanCall[] = [];

mock.module("maw-js/commands/shared/scan-signals", () => ({
  scanSignals: (root: string, opts: { days?: number } = {}) => {
    scanCalls.push({ root, opts });
    if (emitScanWarning) console.error("scan warning", root);
    if (fakeError) throw fakeError;
    return fakeSignals;
  },
}));

const { command, default: handler } = await import(
  "../../src/vendor/mpr-plugins/signals/index.ts?signals-plugin-coverage"
);

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function signal(kind: string, bud: string, message: string, day = "2026-05-18"): FakeSignal {
  return {
    timestamp: `${day}T01:02:03.000Z`,
    bud,
    kind,
    message,
    file: `${day}_${bud}_${message.replace(/\s+/g, "-")}.json`,
  };
}

function freshRoot(): string {
  return mkdtempSync(join(tmpBase, "oracle-"));
}

beforeEach(() => {
  fakeSignals = [];
  fakeError = null;
  emitScanWarning = false;
  scanCalls = [];
  process.chdir(originalCwd);
});

afterEach(() => {
  process.chdir(originalCwd);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("signals plugin index", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "signals",
      description: "List bud signals written to ψ/memory/signals/",
    });
  });

  test("CLI parses --root and --days and renders the empty state", async () => {
    const result = await handler({
      source: "cli",
      args: ["--root", "/tmp/oracle-root", "--days", "3"],
    } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output ?? "")).toBe("  no signals in the last 3 days");
    expect(scanCalls).toEqual([{ root: "/tmp/oracle-root", opts: { days: 3 } }]);
  });

  test("CLI --json serializes scanned signals into captured output", async () => {
    fakeSignals = [signal("info", "alpha", "hello json")];

    const result = await handler({
      source: "cli",
      args: ["--root", "/json-root", "--days", "2", "--json"],
    } as any);

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output ?? "[]")).toEqual(fakeSignals);
    expect(scanCalls).toEqual([{ root: "/json-root", opts: { days: 2 } }]);
  });

  test("API body root/days/json values drive scanning and JSON output", async () => {
    fakeSignals = [signal("pattern", "beta", "api body")];

    const result = await handler({
      source: "api",
      args: { root: "/api-root", days: 4, json: true },
    } as any);

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output ?? "[]")).toEqual(fakeSignals);
    expect(scanCalls).toEqual([{ root: "/api-root", opts: { days: 4 } }]);
  });

  test("writer path formats known signal kinds and unknown-kind fallback without captured output", async () => {
    emitScanWarning = true;
    fakeSignals = [
      signal("alert", "red", "alert branch", "2026-05-18"),
      signal("pattern", "gold", "pattern branch", "2026-05-17"),
      signal("info", "cyan", "info branch", "2026-05-16"),
      signal("mystery", "white", "fallback branch", "2026-05-15"),
    ];
    const writes: string[] = [];

    const result = await handler({
      source: "cli",
      args: ["--root", "/writer-root", "--days", "9"],
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as any);

    const plain = stripAnsi(writes.join("\n"));
    expect(result).toEqual({ ok: true, output: undefined });
    expect(plain).toContain("scan warning /writer-root");
    expect(plain).toContain("Bud signals (last 9d — 4 total)");
    expect(plain).toContain("[alert] 2026-05-18 red: alert branch");
    expect(plain).toContain("[pattern] 2026-05-17 gold: pattern branch");
    expect(plain).toContain("[info] 2026-05-16 cyan: info branch");
    expect(plain).toContain("[mystery] 2026-05-15 white: fallback branch");
    expect(scanCalls).toEqual([{ root: "/writer-root", opts: { days: 9 } }]);
  });

  test("API defaults use process.cwd(), seven days, and non-JSON empty output", async () => {
    const root = freshRoot();
    process.chdir(root);
    const cwdRoot = process.cwd();

    const result = await handler({ source: "api", args: {} } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output ?? "")).toBe("  no signals in the last 7 days");
    expect(scanCalls).toEqual([{ root: cwdRoot, opts: { days: 7 } }]);
  });

  test("scan failures return an error, preserve warning output, and restore console functions", async () => {
    emitScanWarning = true;
    fakeError = new Error("scan exploded");
    const beforeLog = console.log;
    const beforeError = console.error;

    const result = await handler({
      source: "api",
      args: { root: "/bad-root", days: 1 },
    } as any);

    expect(result).toEqual({
      ok: false,
      error: "scan exploded",
      output: "scan warning /bad-root",
    });
    expect(console.log).toBe(beforeLog);
    expect(console.error).toBe(beforeError);
    expect(scanCalls).toEqual([{ root: "/bad-root", opts: { days: 1 } }]);
  });

  test("parse errors return an error with empty output after console restoration", async () => {
    const beforeLog = console.log;
    const beforeError = console.error;

    const result = await handler({ source: "cli" } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("slice");
    expect(result.output).toBeUndefined();
    expect(console.log).toBe(beforeLog);
    expect(console.error).toBe(beforeError);
    expect(scanCalls).toEqual([]);
  });
});
