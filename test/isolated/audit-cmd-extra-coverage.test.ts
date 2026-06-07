import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let auditLines: string[] = [];
let readCounts: number[] = [];

mock.module("maw-js/sdk", () => ({
  readAudit: (count: number) => {
    readCounts.push(count);
    return auditLines;
  },
}));

const { cmdAudit } = await import("../../src/commands/shared/audit.ts?audit-extra");

const originalLog = console.log;
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  auditLines = [];
  readCounts = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
});

describe("cmdAudit extra coverage", () => {
  test("prints empty state after skipping malformed audit lines", async () => {
    auditLines = ["not-json", JSON.stringify({ ts: "bad" })];

    await cmdAudit(["--event", "missing"]);

    expect(readCounts).toEqual([10000]);
    expect(logs.join("\n")).toContain("No audit entries yet");
  });

  test("prints recent audit trail with args and results", async () => {
    auditLines = [
      JSON.stringify({ ts: "2026-05-18T10:20:30.000Z", cmd: "wake", args: ["discord"], result: "ok" }),
      JSON.stringify({ ts: "2026-05-18T10:21:30.000Z", cmd: "ls", args: [], result: "" }),
    ];

    await cmdAudit([]);

    const output = logs.join("\n");
    expect(readCounts).toEqual([20]);
    expect(output).toContain("Audit Trail");
    expect(output).toContain("wake");
    expect(output).toContain("discord");
    expect(output).toContain("→ ok");
    expect(output).toContain("ls");
  });

  test("filters anomaly trail by since and event and prints anomaly input", async () => {
    auditLines = [
      JSON.stringify({ ts: "2026-05-17T00:00:00.000Z", kind: "anomaly", event: "old", input: { q: "skip" } }),
      JSON.stringify({ ts: "2026-05-18T00:00:00.000Z", kind: "anomaly", event: "target", input: { q: "keep" } }),
      JSON.stringify({ ts: "2026-05-18T00:01:00.000Z", event: "target", cmd: "normal" }),
    ];

    await cmdAudit(["--anomalies", "--event", "target", "--since", "2026-05-18T00:00:00.000Z"]);

    const output = logs.join("\n");
    expect(readCounts).toEqual([10000]);
    expect(output).toContain("Anomaly Trail");
    expect(output).toContain("target");
    expect(output).toContain('input={"q":"keep"}');
    expect(output).not.toContain("old");
    expect(output).not.toContain("normal");
  });

  test("ignores invalid --since values instead of filtering", async () => {
    auditLines = [JSON.stringify({ ts: "2026-05-18T00:00:00.000Z", cmd: "kept", args: ["x"] })];

    await cmdAudit(["--since", "not-a-date"]);

    expect(logs.join("\n")).toContain("kept");
  });
});
