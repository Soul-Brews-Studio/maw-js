/**
 * Tests for logAnomaly from src/core/fleet/audit.ts.
 * Uses DI filePath parameter for test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logAnomaly } from "../../src/core/fleet/audit";

let tmp: string;
let auditFile: string;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  auditFile = join(tmp, "audit.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("logAnomaly", () => {
  it("creates audit file and writes JSON line", () => {
    logAnomaly("test-event", {}, auditFile);
    expect(existsSync(auditFile)).toBe(true);
    const line = readFileSync(auditFile, "utf-8").trim();
    const entry = JSON.parse(line);
    expect(entry.kind).toBe("anomaly");
    expect(entry.event).toBe("test-event");
  });

  it("includes timestamp", () => {
    logAnomaly("test", {}, auditFile);
    const entry = JSON.parse(readFileSync(auditFile, "utf-8").trim());
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes input when provided", () => {
    logAnomaly("test", { input: { key: "value" } }, auditFile);
    const entry = JSON.parse(readFileSync(auditFile, "utf-8").trim());
    expect(entry.input).toEqual({ key: "value" });
  });

  it("includes context when provided", () => {
    logAnomaly("test", { context: { detail: 42 } }, auditFile);
    const entry = JSON.parse(readFileSync(auditFile, "utf-8").trim());
    expect(entry.context).toEqual({ detail: 42 });
  });

  it("defaults input and context to empty objects", () => {
    logAnomaly("test", {}, auditFile);
    const entry = JSON.parse(readFileSync(auditFile, "utf-8").trim());
    expect(entry.input).toEqual({});
    expect(entry.context).toEqual({});
  });

  it("includes system info (user, pid, cwd)", () => {
    logAnomaly("test", {}, auditFile);
    const entry = JSON.parse(readFileSync(auditFile, "utf-8").trim());
    expect(typeof entry.user).toBe("string");
    expect(typeof entry.pid).toBe("number");
    expect(typeof entry.cwd).toBe("string");
  });

  it("appends multiple entries", () => {
    logAnomaly("first", {}, auditFile);
    logAnomaly("second", {}, auditFile);
    const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("first");
    expect(JSON.parse(lines[1]).event).toBe("second");
  });

  it("silently handles invalid file path", () => {
    // Should not throw
    logAnomaly("test", {}, "/nonexistent/deep/path/audit.jsonl");
  });
});
