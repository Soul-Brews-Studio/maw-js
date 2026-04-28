/**
 * Tests for acquirePidLock from src/cli/instance-pid.ts.
 * Uses MAW_HOME env to redirect to temp dir. Tests PID file lifecycle.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { acquirePidLock } from "../../src/cli/instance-pid";
import { mkdtempSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmp = mkdtempSync(join(tmpdir(), "pid-lock-test-"));
const origHome = process.env.MAW_HOME;

afterEach(() => {
  // Clean up pid file
  const pidFile = join(tmp, "maw.pid");
  try { unlinkSync(pidFile); } catch {}
  if (origHome) process.env.MAW_HOME = origHome;
  else delete process.env.MAW_HOME;
});

describe("acquirePidLock", () => {
  it("creates maw.pid file", () => {
    process.env.MAW_HOME = tmp;
    acquirePidLock(null);
    expect(existsSync(join(tmp, "maw.pid"))).toBe(true);
  });

  it("writes current PID to file", () => {
    process.env.MAW_HOME = tmp;
    acquirePidLock(null);
    const content = readFileSync(join(tmp, "maw.pid"), "utf-8");
    expect(content).toBe(String(process.pid));
  });

  it("steals lock from dead pid", () => {
    process.env.MAW_HOME = tmp;
    writeFileSync(join(tmp, "maw.pid"), "999999999");
    acquirePidLock("test-instance");
    const content = readFileSync(join(tmp, "maw.pid"), "utf-8");
    expect(content).toBe(String(process.pid));
  });

  it("works with named instance", () => {
    process.env.MAW_HOME = tmp;
    acquirePidLock("my-instance");
    expect(existsSync(join(tmp, "maw.pid"))).toBe(true);
  });
});
