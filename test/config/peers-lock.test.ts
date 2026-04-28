/**
 * Tests for withPeersLock from src/commands/plugins/peers/lock.ts.
 * Uses real temp files — no mocking needed.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { withPeersLock } from "../../src/commands/plugins/peers/lock";
import { mkdtempSync, existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "peers-lock-test-"));
let counter = 0;
function freshPath() {
  return join(tmp, `peers-${counter++}.json`);
}

afterEach(() => {
  // Clean up any stale lock files
  try {
    const files = require("fs").readdirSync(tmp);
    for (const f of files) {
      if (f.endsWith(".lock")) {
        try { unlinkSync(join(tmp, f)); } catch {}
      }
    }
  } catch {}
});

describe("withPeersLock", () => {
  it("executes fn and returns its result", () => {
    const path = freshPath();
    const result = withPeersLock(path, () => 42);
    expect(result).toBe(42);
  });

  it("removes lock file after success", () => {
    const path = freshPath();
    withPeersLock(path, () => {});
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("removes lock file after fn throws", () => {
    const path = freshPath();
    expect(() => withPeersLock(path, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("propagates return value from fn", () => {
    const path = freshPath();
    const result = withPeersLock(path, () => ({ key: "value", num: 123 }));
    expect(result).toEqual({ key: "value", num: 123 });
  });

  it("serializes concurrent access (lock file exists during fn)", () => {
    const path = freshPath();
    let lockExisted = false;
    withPeersLock(path, () => {
      lockExisted = existsSync(`${path}.lock`);
    });
    expect(lockExisted).toBe(true);
  });

  it("steals lock from dead pid", () => {
    const path = freshPath();
    // Write a lock file with a non-existent pid
    writeFileSync(`${path}.lock`, "999999999");
    const result = withPeersLock(path, () => "stolen");
    expect(result).toBe("stolen");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("writes current pid to lock file", () => {
    const path = freshPath();
    let lockContent = "";
    withPeersLock(path, () => {
      lockContent = readFileSync(`${path}.lock`, "utf-8");
    });
    expect(lockContent).toBe(String(process.pid));
  });
});
