/**
 * Extra isolated coverage for fleet audit helpers.
 * @maw-test-isolate
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mawConfigDir = mkdtempSync(join(tmpdir(), "maw-audit-config-"));
const mawStateDir = mkdtempSync(join(tmpdir(), "maw-audit-state-"));
process.env.MAW_CONFIG_DIR = mawConfigDir;
process.env.MAW_STATE_DIR = mawStateDir;
process.env.USER = "coverage-user";

const { auditFilePath, logAudit, logAnomaly, readAudit } = await import("../../src/core/fleet/audit.ts?coverage");
const auditFile = join(mawStateDir, "audit.jsonl");

afterAll(() => {
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_STATE_DIR;
  rmSync(mawConfigDir, { recursive: true, force: true });
  rmSync(mawStateDir, { recursive: true, force: true });
});

describe("fleet audit helpers", () => {
  test("logAudit appends command entries with optional result and readAudit tails them", () => {
    expect(readAudit()).toEqual([]);

    logAudit("wake", ["neo"], "ok");
    logAudit("ls", []);

    expect(existsSync(auditFile)).toBe(true);
    const entries = readAudit(1).map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cmd: "ls", args: [], user: "coverage-user" });
    expect(entries[0].result).toBeUndefined();

    const all = readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(all[0]).toMatchObject({ cmd: "wake", args: ["neo"], result: "ok" });
    expect(typeof all[0].pid).toBe("number");
    expect(new Date(all[0].ts).getTime()).toBeGreaterThan(0);
  });

  test("logAnomaly appends cwd/tty context to explicit audit path", () => {
    const filePath = join(mawConfigDir, "anomaly.jsonl");

    logAnomaly("resolver-ambiguous", { input: { q: "neo" }, context: { count: 2 } }, filePath);

    const entry = JSON.parse(readFileSync(filePath, "utf8").trim());
    expect(entry).toMatchObject({
      kind: "anomaly",
      event: "resolver-ambiguous",
      input: { q: "neo" },
      context: { count: 2 },
    });
    expect(typeof entry.cwd).toBe("string");
    expect(entry.tty === null || typeof entry.tty === "string").toBe(true);
  });

  test("audit helpers resolve the state audit path at operation time", () => {
    const dynamicState = mkdtempSync(join(tmpdir(), "maw-audit-dynamic-state-"));
    process.env.MAW_STATE_DIR = dynamicState;
    try {
      const dynamicAuditFile = join(dynamicState, "audit.jsonl");

      expect(auditFilePath()).toBe(dynamicAuditFile);
      expect(readAudit()).toEqual([]);

      logAudit("doctor", ["xdg"], "ok");

      expect(existsSync(dynamicAuditFile)).toBe(true);
      const entry = JSON.parse(readFileSync(dynamicAuditFile, "utf8").trim());
      expect(entry).toMatchObject({ cmd: "doctor", args: ["xdg"], result: "ok" });
    } finally {
      process.env.MAW_STATE_DIR = mawStateDir;
      rmSync(dynamicState, { recursive: true, force: true });
    }
  });
});
