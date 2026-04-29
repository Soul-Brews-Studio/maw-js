/**
 * scope-acl — pure ACL evaluation tests (#642 Phase 2 / Sub-A of #842).
 *
 * Covers the `evaluateAcl(sender, target, scopes, trust?)` decision function
 * plus the filesystem helper `loadAllScopes()` that mirrors Phase 1's
 * `cmdList()` body. Sub-A ships the function only — caller integration into
 * `comm-send.ts` is Sub-B/C work to keep this PR focused.
 *
 * Isolation: same MAW_CONFIG_DIR / MAW_HOME pattern as scope-primitive.test.ts
 * so Phase 1's `scopesDir()` resolves to a per-test temp directory. Each
 * isolated test file runs in its own bun process via scripts/test-isolated.sh,
 * so the module cache is fresh and per-test env tweaks are safe.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-scope-acl-"));
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

// Helper: build a fully-formed TScope without going through cmdCreate (most
// tests don't need the on-disk side effect — they just exercise evaluateAcl).
function scope(name: string, members: string[], lead?: string) {
  return {
    name,
    members,
    lead,
    created: "2026-04-28T00:00:00.000Z",
    ttl: null,
  };
}

describe("evaluateAcl — same-scope rule", () => {
  test("sender + target in same scope → allow", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("market", ["alpha", "beta", "gamma"])];
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("allow");
  });

  test("sender + target in different scopes → queue", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [
      scope("market", ["alpha", "beta"]),
      scope("research", ["gamma", "delta"]),
    ];
    expect(evaluateAcl("alpha", "gamma", scopes)).toBe("queue");
  });

  test("sender in scope, target NOT in scope → queue", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("market", ["alpha", "beta"])];
    expect(evaluateAcl("alpha", "stranger", scopes)).toBe("queue");
  });

  test("target in scope, sender NOT in scope → queue", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("market", ["beta"])];
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("queue");
  });
});

describe("evaluateAcl — multi-scope membership", () => {
  test("sender in 2 scopes (one shared with target) → allow", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [
      scope("market", ["alpha", "beta"]),
      scope("research", ["alpha", "gamma"]),
    ];
    // alpha shares "research" with gamma even though they're not both in market.
    expect(evaluateAcl("alpha", "gamma", scopes)).toBe("allow");
  });

  test("multiple scope overlaps → allow (any one suffices)", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [
      scope("market", ["alpha", "beta"]),
      scope("research", ["alpha", "beta"]),
      scope("ops", ["alpha", "beta"]),
    ];
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("allow");
  });

  test("symmetric: target's scopes count too (a→b same as b→a for membership)", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("market", ["alpha", "beta"])];
    expect(evaluateAcl("beta", "alpha", scopes)).toBe("allow");
  });
});

describe("evaluateAcl — empty / edge cases", () => {
  test("empty scopes list + no trust → queue (default-deny cross)", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    expect(evaluateAcl("alpha", "beta", [])).toBe("queue");
  });

  test("scope with empty members array → queue", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("ghost", [])];
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("queue");
  });

  test("scope with only sender (single-member) → queue when target absent", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("solo", ["alpha"])];
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("queue");
  });
});

describe("evaluateAcl — self-message rule", () => {
  test("sender == target → allow even with no scopes", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    expect(evaluateAcl("alpha", "alpha", [])).toBe("allow");
  });

  test("sender == target → allow even when not in any scope", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("market", ["beta", "gamma"])];
    expect(evaluateAcl("alpha", "alpha", scopes)).toBe("allow");
  });

  test("sender == target → allow regardless of trust list", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    expect(evaluateAcl("alpha", "alpha", [], [])).toBe("allow");
  });
});

describe("evaluateAcl — trust list", () => {
  test("trust list pair → allow even without shared scope", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const trust = [{ sender: "alpha", target: "beta" }];
    expect(evaluateAcl("alpha", "beta", [], trust)).toBe("allow");
  });

  test("trust list is symmetric: {a→b} also covers b→a", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const trust = [{ sender: "alpha", target: "beta" }];
    expect(evaluateAcl("beta", "alpha", [], trust)).toBe("allow");
  });

  test("trust list MISS → still queue when scopes don't cover it", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const trust = [{ sender: "alpha", target: "beta" }];
    expect(evaluateAcl("alpha", "gamma", [], trust)).toBe("queue");
  });

  test("trust list overrides absent scope membership → allow", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [scope("market", ["x", "y"])]; // sender + target NOT here
    const trust = [{ sender: "alpha", target: "beta" }];
    expect(evaluateAcl("alpha", "beta", scopes, trust)).toBe("allow");
  });

  test("undefined trust list → treated as empty, no crash", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    expect(evaluateAcl("alpha", "beta", [], undefined)).toBe("queue");
  });

  test("empty trust list → equivalent to undefined", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    expect(evaluateAcl("alpha", "beta", [], [])).toBe("queue");
  });
});

describe("loadAllScopes — filesystem helper", () => {
  test("missing scopes/ dir → returns empty array", async () => {
    const { loadAllScopes } = await import("../../src/commands/shared/scope-acl");
    expect(loadAllScopes()).toEqual([]);
  });

  test("reads scopes written by Phase 1 cmdCreate", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    const { loadAllScopes } = await import("../../src/commands/shared/scope-acl");
    cmdCreate({ name: "market", members: ["alpha", "beta"] });
    cmdCreate({ name: "research", members: ["gamma"] });
    const all = loadAllScopes();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.name).sort()).toEqual(["market", "research"]);
  });

  test("ignores non-JSON files alongside scope JSONs", async () => {
    const { cmdCreate, scopesDir } = await import("../../src/commands/plugins/scope/impl");
    const { loadAllScopes } = await import("../../src/commands/shared/scope-acl");
    cmdCreate({ name: "real", members: ["a"] });
    writeFileSync(join(scopesDir(), "README.md"), "operator notes");
    const all = loadAllScopes();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("real");
  });

  test("silently skips corrupt JSON files", async () => {
    const { cmdCreate, scopesDir } = await import("../../src/commands/plugins/scope/impl");
    const { loadAllScopes } = await import("../../src/commands/shared/scope-acl");
    cmdCreate({ name: "good", members: ["a"] });
    writeFileSync(join(scopesDir(), "broken.json"), "{ this is not json");
    const all = loadAllScopes();
    expect(all.map(s => s.name)).toEqual(["good"]);
  });

  test("loadAllScopes feeds evaluateAcl end-to-end", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    const { loadAllScopes, evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    cmdCreate({ name: "team", members: ["alpha", "beta"] });
    const scopes = loadAllScopes();
    expect(evaluateAcl("alpha", "beta", scopes)).toBe("allow");
    expect(evaluateAcl("alpha", "stranger", scopes)).toBe("queue");
  });

  test("skips scope file with malformed shape (missing members)", async () => {
    const dir = join(testDir, "scopes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "weird.json"), JSON.stringify({ name: "weird" }));
    const { loadAllScopes } = await import("../../src/commands/shared/scope-acl");
    expect(loadAllScopes()).toEqual([]);
  });
});

describe("evaluateAcl — composition smoke tests", () => {
  test("real-world-ish: market scope + cross-scope trust pair", async () => {
    const { evaluateAcl } = await import("../../src/commands/shared/scope-acl");
    const scopes = [
      scope("market", ["mawjs", "mawjs-plugin", "security"]),
      scope("research", ["neo", "pulse"]),
    ];
    const trust = [{ sender: "mawjs", target: "neo" }];
    // Same scope:
    expect(evaluateAcl("mawjs", "security", scopes, trust)).toBe("allow");
    // Cross scope but trusted:
    expect(evaluateAcl("mawjs", "neo", scopes, trust)).toBe("allow");
    // Untrusted cross:
    expect(evaluateAcl("security", "pulse", scopes, trust)).toBe("queue");
    // Self:
    expect(evaluateAcl("mawjs", "mawjs", scopes, trust)).toBe("allow");
  });
});
