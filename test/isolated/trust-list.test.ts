/**
 * trust-list — storage + CLI primitive tests (#842 Sub-B).
 *
 * Covers:
 *   - `loadTrust()` / `saveTrust()` round-trip
 *   - `cmdList` / `cmdAdd` / `cmdRemove` semantics (idempotent add,
 *     symmetric match, error on missing remove, validation)
 *   - `loadTrustFromDisk()` + `evaluateAclFromDisk()` integration with
 *     the Sub-A ACL evaluator
 *   - Forgiving load (missing / corrupt file → [])
 *
 * Isolation: same MAW_CONFIG_DIR / MAW_HOME pattern as
 * scope-acl.test.ts so the trust file resolves to a per-test temp
 * directory. Each isolated test file runs in its own bun process via
 * scripts/test-isolated.sh, so the module cache is fresh and per-test
 * env tweaks are safe.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-trust-list-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = testDir;
  delete process.env.MAW_HOME;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("trust store — load/save round-trip", () => {
  test("missing trust.json → loadTrust returns empty array", async () => {
    const { loadTrust } = await import("../../src/commands/plugins/trust/store");
    expect(loadTrust()).toEqual([]);
  });

  test("saveTrust then loadTrust round-trips a single entry", async () => {
    const { loadTrust, saveTrust } = await import("../../src/commands/plugins/trust/store");
    const entry = { sender: "alpha", target: "beta", addedAt: "2026-04-28T00:00:00.000Z" };
    saveTrust([entry]);
    const loaded = loadTrust();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(entry);
  });

  test("saveTrust writes atomically (no .tmp left after success)", async () => {
    const { saveTrust, trustPath } = await import("../../src/commands/plugins/trust/store");
    saveTrust([{ sender: "a", target: "b", addedAt: "2026-04-28T00:00:00.000Z" }]);
    // File exists, .tmp does not
    expect(() => readFileSync(trustPath(), "utf-8")).not.toThrow();
    expect(() => readFileSync(`${trustPath()}.tmp`, "utf-8")).toThrow();
  });

  test("loadTrust on corrupt JSON → empty array (forgiving)", async () => {
    const { loadTrust, trustPath } = await import("../../src/commands/plugins/trust/store");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(trustPath(), "{ this is not valid json");
    expect(loadTrust()).toEqual([]);
  });

  test("loadTrust on non-array root JSON → empty array (forgiving)", async () => {
    const { loadTrust, trustPath } = await import("../../src/commands/plugins/trust/store");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(trustPath(), JSON.stringify({ entries: [] }));
    expect(loadTrust()).toEqual([]);
  });

  test("loadTrust skips malformed entries but keeps valid ones", async () => {
    const { loadTrust, trustPath } = await import("../../src/commands/plugins/trust/store");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(trustPath(), JSON.stringify([
      { sender: "a", target: "b", addedAt: "2026-04-28T00:00:00.000Z" },
      { sender: "c" },                                  // missing target + addedAt
      { sender: 1, target: 2, addedAt: 3 },             // wrong types
      { sender: "d", target: "e", addedAt: "2026-04-28T00:00:01.000Z" },
    ]));
    const loaded = loadTrust();
    expect(loaded).toHaveLength(2);
    expect(loaded.map(e => e.sender).sort()).toEqual(["a", "d"]);
  });
});

describe("cmdAdd — idempotent + symmetric", () => {
  test("add → list shows the new entry", async () => {
    const { cmdAdd, cmdList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    const list = cmdList();
    expect(list).toHaveLength(1);
    expect(list[0].sender).toBe("alpha");
    expect(list[0].target).toBe("beta");
    expect(typeof list[0].addedAt).toBe("string");
  });

  test("add duplicate → idempotent (no dupe on disk)", async () => {
    const { cmdAdd, cmdList } = await import("../../src/commands/plugins/trust/impl");
    const first = cmdAdd("alpha", "beta");
    const second = cmdAdd("alpha", "beta");
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.entry.addedAt).toBe(first.entry.addedAt); // same entry
    expect(cmdList()).toHaveLength(1);
  });

  test("add reverse pair → idempotent (symmetric, no dupe)", async () => {
    const { cmdAdd, cmdList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    const second = cmdAdd("beta", "alpha");
    expect(second.added).toBe(false);
    expect(cmdList()).toHaveLength(1);
  });

  test("add multiple distinct pairs → all kept", async () => {
    const { cmdAdd, cmdList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    cmdAdd("gamma", "delta");
    cmdAdd("alpha", "delta");
    expect(cmdList()).toHaveLength(3);
  });

  test("add self-trust pair → throws", async () => {
    const { cmdAdd } = await import("../../src/commands/plugins/trust/impl");
    expect(() => cmdAdd("alpha", "alpha")).toThrow(/self-trust/);
  });

  test("add empty sender / target → throws", async () => {
    const { cmdAdd } = await import("../../src/commands/plugins/trust/impl");
    expect(() => cmdAdd("", "beta")).toThrow(/non-empty/);
    expect(() => cmdAdd("alpha", "")).toThrow(/non-empty/);
  });
});

describe("cmdRemove — exact-or-error, symmetric", () => {
  test("remove existing entry → entry gone from list", async () => {
    const { cmdAdd, cmdRemove, cmdList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    expect(cmdList()).toHaveLength(1);
    const removed = cmdRemove("alpha", "beta");
    expect(removed.sender).toBe("alpha");
    expect(removed.target).toBe("beta");
    expect(cmdList()).toEqual([]);
  });

  test("remove with reversed args → matches symmetrically", async () => {
    const { cmdAdd, cmdRemove, cmdList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    cmdRemove("beta", "alpha");
    expect(cmdList()).toEqual([]);
  });

  test("remove non-existent pair → throws", async () => {
    const { cmdRemove } = await import("../../src/commands/plugins/trust/impl");
    expect(() => cmdRemove("ghost", "phantom")).toThrow(/no entry found/);
  });

  test("remove only one of many → others preserved", async () => {
    const { cmdAdd, cmdRemove, cmdList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    cmdAdd("gamma", "delta");
    cmdAdd("eps", "zeta");
    cmdRemove("gamma", "delta");
    const remaining = cmdList().map(e => `${e.sender}-${e.target}`).sort();
    expect(remaining).toEqual(["alpha-beta", "eps-zeta"]);
  });
});

describe("formatList — operator output", () => {
  test("empty list → 'no trust entries'", async () => {
    const { formatList } = await import("../../src/commands/plugins/trust/impl");
    expect(formatList([])).toBe("no trust entries");
  });

  test("non-empty list → header + rows aligned", async () => {
    const { cmdAdd, cmdList, formatList } = await import("../../src/commands/plugins/trust/impl");
    cmdAdd("alpha", "beta");
    cmdAdd("gamma", "delta");
    const out = formatList(cmdList());
    expect(out).toContain("sender");
    expect(out).toContain("target");
    expect(out).toContain("addedAt");
    expect(out).toContain("alpha");
    expect(out).toContain("delta");
  });
});

describe("evaluateAcl integration via on-disk trust list", () => {
  test("loadTrustFromDisk on missing file → empty list", async () => {
    const { loadTrustFromDisk } = await import("../../src/commands/shared/scope-acl");
    expect(loadTrustFromDisk()).toEqual([]);
  });

  test("loadTrustFromDisk reads entries written by cmdAdd", async () => {
    const { cmdAdd } = await import("../../src/commands/plugins/trust/impl");
    const { loadTrustFromDisk } = await import("../../src/commands/shared/scope-acl");
    cmdAdd("alpha", "beta");
    cmdAdd("gamma", "delta");
    const list = loadTrustFromDisk();
    expect(list).toHaveLength(2);
    // Order: cmdAdd appends; loadTrustFromDisk preserves on-disk order.
    expect(list.find(e => e.sender === "alpha" && e.target === "beta")).toBeTruthy();
    expect(list.find(e => e.sender === "gamma" && e.target === "delta")).toBeTruthy();
  });

  test("evaluateAcl with loadTrustFromDisk → trust pair allowed across scopes", async () => {
    const { cmdAdd } = await import("../../src/commands/plugins/trust/impl");
    const { evaluateAcl, loadTrustFromDisk } = await import("../../src/commands/shared/scope-acl");
    cmdAdd("alpha", "beta");
    const trust = loadTrustFromDisk();
    // No scopes — only trust list grants the allow.
    expect(evaluateAcl("alpha", "beta", [], trust)).toBe("allow");
    expect(evaluateAcl("beta", "alpha", [], trust)).toBe("allow"); // symmetric
    expect(evaluateAcl("alpha", "stranger", [], trust)).toBe("queue");
  });

  test("evaluateAclFromDisk composes scopes + trust loaders", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    const { cmdAdd } = await import("../../src/commands/plugins/trust/impl");
    const { evaluateAclFromDisk } = await import("../../src/commands/shared/scope-acl");

    cmdCreate({ name: "market", members: ["alpha", "beta"] });
    cmdAdd("alpha", "neo"); // cross-scope trust pair

    expect(evaluateAclFromDisk("alpha", "beta")).toBe("allow");   // shared scope
    expect(evaluateAclFromDisk("alpha", "neo")).toBe("allow");    // trust list
    expect(evaluateAclFromDisk("neo", "alpha")).toBe("allow");    // symmetric
    expect(evaluateAclFromDisk("alpha", "stranger")).toBe("queue"); // neither
    expect(evaluateAclFromDisk("alpha", "alpha")).toBe("allow");  // self
  });

  test("evaluateAclFromDisk works with no scopes file and no trust file", async () => {
    const { evaluateAclFromDisk } = await import("../../src/commands/shared/scope-acl");
    // Default-deny: empty everything → queue across, allow self.
    expect(evaluateAclFromDisk("alpha", "beta")).toBe("queue");
    expect(evaluateAclFromDisk("alpha", "alpha")).toBe("allow");
  });

  test("removed trust pair no longer grants allow", async () => {
    const { cmdAdd, cmdRemove } = await import("../../src/commands/plugins/trust/impl");
    const { evaluateAclFromDisk } = await import("../../src/commands/shared/scope-acl");
    cmdAdd("alpha", "beta");
    expect(evaluateAclFromDisk("alpha", "beta")).toBe("allow");
    cmdRemove("alpha", "beta");
    expect(evaluateAclFromDisk("alpha", "beta")).toBe("queue");
  });
});
