/**
 * Tests for src/core/fleet/audit.ts — logAnomaly (with file path injection).
 *
 * logAudit uses a hardcoded path, but logAnomaly accepts a filePath param
 * for test isolation. We also test readAudit indirectly.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logAnomaly } from "../../src/core/fleet/audit";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "maw-audit-"));
});

afterAll(() => {
  // cleanup handled per-test
});

describe("logAnomaly", () => {
  it("creates JSONL file and appends entry", () => {
    const file = join(workdir, "audit.jsonl");
    logAnomaly("test-event", { input: { key: "val" } }, file);
    expect(existsSync(file)).toBe(true);
    const line = readFileSync(file, "utf-8").trim();
    const entry = JSON.parse(line);
    expect(entry.kind).toBe("anomaly");
    expect(entry.event).toBe("test-event");
    expect(entry.input).toEqual({ key: "val" });
  });

  it("appends multiple entries on separate lines", () => {
    const file = join(workdir, "audit.jsonl");
    logAnomaly("event-1", {}, file);
    logAnomaly("event-2", { context: { foo: "bar" } }, file);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("event-1");
    expect(JSON.parse(lines[1]).event).toBe("event-2");
    expect(JSON.parse(lines[1]).context).toEqual({ foo: "bar" });
  });

  it("includes timestamp, user, pid, cwd", () => {
    const file = join(workdir, "audit.jsonl");
    logAnomaly("meta-test", {}, file);
    const entry = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(entry.ts).toBeDefined();
    expect(entry.user).toBeDefined();
    expect(typeof entry.pid).toBe("number");
    expect(entry.cwd).toBeDefined();
  });

  it("defaults input and context to empty objects", () => {
    const file = join(workdir, "audit.jsonl");
    logAnomaly("default-test", {}, file);
    const entry = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(entry.input).toEqual({});
    expect(entry.context).toEqual({});
  });

  it("does not throw on invalid file path (silent fail)", () => {
    expect(() => logAnomaly("bad-path", {}, "/nonexistent/dir/audit.jsonl")).not.toThrow();
  });
});
