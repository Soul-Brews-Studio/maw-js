import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const scanCalls: Array<{ root: string; opts: { days?: number } }> = [];
let scannedSignals: Array<{
  timestamp: string;
  bud: string;
  kind: "info" | "alert" | "pattern" | string;
  message: string;
  file: string;
}> = [];

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  parseFlags: (args: string[], spec: Record<string, unknown>) => {
    const out: Record<string, unknown> & { _: string[] } = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const parser = spec[arg];
      if (!parser) {
        out._.push(arg);
      } else if (parser === Boolean) {
        out[arg] = true;
      } else {
        const value = args[++i];
        if (value === undefined) throw new Error(`option requires argument: ${arg}`);
        out[arg] = parser === Number ? Number(value) : value;
      }
    }
    return out;
  },
  scanSignals: (root: string, opts: { days?: number } = {}) => {
    scanCalls.push({ root, opts });
    return scannedSignals;
  },
}));

const { default: signalsHandler } = await import("../../src/vendor/mpr-plugins/signals/index.ts?plugin-signals-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  scanCalls.length = 0;
  scannedSignals = [];
});

describe("signals plugin standalone boundary (#2113)", () => {
  test("imports runtime behavior from the SDK boundary", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/signals/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|lib|config)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("CLI handler scans configured root and renders human output", async () => {
    scannedSignals = [
      { timestamp: "2026-06-06T01:02:03.000Z", bud: "neo", kind: "alert", message: "needs attention", file: "alert.json" },
      { timestamp: "2026-06-05T01:02:03.000Z", bud: "trinity", kind: "pattern", message: "pattern found", file: "pattern.json" },
    ];

    const result = await signalsHandler({ source: "cli", args: ["--root", "/tmp/oracle", "--days", "3"] } as any);

    expect(result.ok).toBe(true);
    expect(scanCalls).toEqual([{ root: "/tmp/oracle", opts: { days: 3 } }]);
    const output = stripAnsi(result.output);
    expect(output).toContain("Bud signals");
    expect(output).toContain("last 3d — 2 total");
    expect(output).toContain("[alert] 2026-06-06 neo: needs attention");
    expect(output).toContain("[pattern] 2026-06-05 trinity: pattern found");
  });

  test("API handler supports JSON output", async () => {
    scannedSignals = [
      { timestamp: "2026-06-06T01:02:03.000Z", bud: "neo", kind: "info", message: "hello", file: "info.json" },
    ];

    const result = await signalsHandler({ source: "api", args: { root: "/api/root", days: 9, json: true } } as any);

    expect(result.ok).toBe(true);
    expect(scanCalls).toEqual([{ root: "/api/root", opts: { days: 9 } }]);
    expect(JSON.parse(result.output ?? "[]")).toEqual(scannedSignals);
  });

  test("empty scan reports no signals", async () => {
    const result = await signalsHandler({ source: "cli", args: ["--days", "2"] } as any);

    expect(result.ok).toBe(true);
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0]!.opts).toEqual({ days: 2 });
    expect(stripAnsi(result.output)).toContain("no signals in the last 2 days");
  });
});
