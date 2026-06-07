/** Extra isolated coverage for vendor peers lock stale/timeout branches. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { withPeersLock } = await import("../../src/vendor/mpr-plugins/peers/lock.ts?vendor-peers-lock-extra");

let dir = "";
const originalKill = process.kill;
const originalNow = Date.now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-vendor-peers-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.kill = originalKill;
  Date.now = originalNow;
});

describe("vendor peers lock extra coverage", () => {
  test("creates a pid lock, returns callback value, and removes the lock afterward", () => {
    const peers = join(dir, "peers.json");
    let observedPid = "";

    const result = withPeersLock(peers, () => {
      const lock = `${peers}.lock`;
      expect(existsSync(lock)).toBe(true);
      observedPid = readFileSync(lock, "utf-8");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(observedPid).toBe(String(process.pid));
    expect(existsSync(`${peers}.lock`)).toBe(false);
  });

  test("steals stale, empty, invalid, and ESRCH-held lock files", () => {
    const peers = join(dir, "peers.json");
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      void signal;
      const err = new Error(`dead ${pid}`) as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as typeof process.kill;

    for (const contents of ["", "not-a-pid", "424242"]) {
      writeFileSync(`${peers}.lock`, contents, "utf-8");
      expect(withPeersLock(peers, () => `stole:${contents || "empty"}`)).toBe(`stole:${contents || "empty"}`);
      expect(existsSync(`${peers}.lock`)).toBe(false);
    }
  });

  test("treats EPERM as alive and times out without deleting the holder lock", () => {
    const peers = join(dir, "peers.json");
    writeFileSync(`${peers}.lock`, "1234", "utf-8");
    process.kill = (() => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;

    let now = 1_000;
    Date.now = () => {
      now += 10_000;
      return now;
    };

    expect(() => withPeersLock(peers, () => "never")).toThrow(/peers lock timeout: pid 1234 still holds/);
    expect(readFileSync(`${peers}.lock`, "utf-8")).toBe("1234");
  });

  test("non-EEXIST open failures bubble to the caller", () => {
    const badPath = join(dir, "missing", "peers.json");
    expect(() => withPeersLock(badPath, () => "never")).toThrow();
  });
});
