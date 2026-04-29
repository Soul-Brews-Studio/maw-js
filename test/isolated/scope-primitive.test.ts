/**
 * scope primitive — unit tests (#642 Phase 1).
 *
 * Tests the per-scope JSON file primitive plus the maw scope CLI dispatcher.
 * Phase 1 covers ONLY the data primitive + CLI verbs (list/create/show/delete);
 * ACL evaluation, trust list, and the cross-scope approval queue are deferred
 * to follow-up issues.
 *
 * Isolation: we set MAW_CONFIG_DIR + MAW_HOME before any dynamic import so
 * core/paths.ts evaluates against the temp dir. Each isolated test file runs
 * in its own bun process via scripts/test-isolated.sh, so the module cache
 * is fresh and per-test env tweaks are safe.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-scope-"));
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

describe("scope impl — name validation", () => {
  test("validateScopeName accepts slugs and rejects junk", async () => {
    const { validateScopeName } = await import("../../src/commands/plugins/scope/impl");
    expect(validateScopeName("marketplace-work")).toBeNull();
    expect(validateScopeName("a")).toBeNull();
    expect(validateScopeName("scope_1")).toBeNull();
    expect(validateScopeName("")).not.toBeNull();
    expect(validateScopeName("-bad")).not.toBeNull();
    expect(validateScopeName("BAD")).not.toBeNull();
    expect(validateScopeName("a".repeat(65))).not.toBeNull();
  });
});

describe("scope impl — create / list / show / delete", () => {
  test("create then list shows the new scope", async () => {
    const { cmdCreate, cmdList } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({
      name: "marketplace-work",
      members: ["mawjs", "mawjs-plugin", "security"],
      lead: "mawjs",
    });
    const all = cmdList();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("marketplace-work");
    expect(all[0].members).toEqual(["mawjs", "mawjs-plugin", "security"]);
    expect(all[0].lead).toBe("mawjs");
    expect(all[0].ttl).toBeNull();
    expect(typeof all[0].created).toBe("string");
  });

  test("create persists JSON to <CONFIG_DIR>/scopes/<name>.json", async () => {
    const { cmdCreate, scopePath } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "bench", members: ["alpha", "beta"] });
    const path = scopePath("bench");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.name).toBe("bench");
    expect(parsed.members).toEqual(["alpha", "beta"]);
    expect(parsed).not.toHaveProperty("lead");
    expect(parsed.ttl).toBeNull();
  });

  test("create rejects duplicate names (no overwrite)", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "dup", members: ["a"] });
    expect(() => cmdCreate({ name: "dup", members: ["b"] })).toThrow(/already exists/);
  });

  test("create rejects invalid name", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    expect(() => cmdCreate({ name: "BAD!", members: ["a"] })).toThrow(/invalid scope name/);
  });

  test("create rejects empty member list", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    expect(() => cmdCreate({ name: "empty", members: [] })).toThrow(/at least one member/);
  });

  test("create rejects lead not in members", async () => {
    const { cmdCreate } = await import("../../src/commands/plugins/scope/impl");
    expect(() => cmdCreate({ name: "lead-bad", members: ["alpha"], lead: "ghost" }))
      .toThrow(/lead "ghost" is not in members/);
  });

  test("show returns scope object for known name", async () => {
    const { cmdCreate, cmdShow } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "vis", members: ["a", "b"], lead: "a" });
    const found = cmdShow("vis");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("vis");
    expect(found?.lead).toBe("a");
  });

  test("show returns null for non-existent name (CLI translates to error)", async () => {
    const { cmdShow } = await import("../../src/commands/plugins/scope/impl");
    expect(cmdShow("ghost")).toBeNull();
  });

  test("show rejects invalid name format", async () => {
    const { cmdShow } = await import("../../src/commands/plugins/scope/impl");
    expect(() => cmdShow("BAD!")).toThrow(/invalid scope name/);
  });

  test("delete removes the scope file", async () => {
    const { cmdCreate, cmdDelete, cmdList, scopePath } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "victim", members: ["a"] });
    expect(existsSync(scopePath("victim"))).toBe(true);
    expect(cmdDelete("victim")).toBe(true);
    expect(existsSync(scopePath("victim"))).toBe(false);
    expect(cmdList()).toHaveLength(0);
  });

  test("delete is idempotent (returns false on missing)", async () => {
    const { cmdDelete } = await import("../../src/commands/plugins/scope/impl");
    expect(cmdDelete("ghost")).toBe(false);
  });

  test("members list is editable on disk (operator workflow)", async () => {
    const { cmdCreate, cmdShow, scopePath } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "edit-me", members: ["alpha", "beta"] });
    const path = scopePath("edit-me");

    // Operator hand-edits the JSON to add a member.
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    parsed.members.push("gamma");
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");

    const reloaded = cmdShow("edit-me");
    expect(reloaded?.members).toEqual(["alpha", "beta", "gamma"]);
  });

  test("list is empty on a fresh CONFIG_DIR", async () => {
    const { cmdList } = await import("../../src/commands/plugins/scope/impl");
    expect(cmdList()).toEqual([]);
  });

  test("list ignores non-JSON files in scopes dir", async () => {
    const { cmdCreate, cmdList, scopesDir } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "real", members: ["a"] });
    // Drop a stray non-JSON file alongside.
    writeFileSync(join(scopesDir(), "README.md"), "operator notes");
    const all = cmdList();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("real");
  });

  test("list silently skips a corrupt JSON file", async () => {
    const { cmdCreate, cmdList, scopesDir } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "good", members: ["a"] });
    writeFileSync(join(scopesDir(), "broken.json"), "{ this is not json");
    const all = cmdList();
    // Phase 1 is forgiving — corrupt files don't blow up `list`. Operator can
    // diff the file by hand. Phase 2 may add a louder diagnostic.
    expect(all.map(s => s.name)).toEqual(["good"]);
  });
});

describe("scope impl — formatList", () => {
  test("renders header + rows when non-empty", async () => {
    const { cmdCreate, cmdList, formatList } = await import("../../src/commands/plugins/scope/impl");
    cmdCreate({ name: "bench", members: ["a", "b"], lead: "a" });
    const out = formatList(cmdList());
    expect(out).toContain("name");
    expect(out).toContain("members");
    expect(out).toContain("lead");
    expect(out).toContain("bench");
    expect(out).toContain("a,b");
  });

  test("renders placeholder when empty", async () => {
    const { formatList } = await import("../../src/commands/plugins/scope/impl");
    expect(formatList([])).toBe("no scopes");
  });
});

describe("scope dispatcher (index.ts)", () => {
  test("no args → prints help", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const res = await handler({ source: "cli", args: [] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("usage: maw scope");
    expect(res.output).toContain("Phase 1 of #642");
  });

  test("unknown subcommand → error + help in output", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const res = await handler({ source: "cli", args: ["wat"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown subcommand");
  });

  test("create then list through dispatcher", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const create = await handler({
      source: "cli",
      args: ["create", "marketplace-work", "--members", "mawjs,mawjs-plugin,security", "--lead", "mawjs"],
    });
    expect(create.ok).toBe(true);
    expect(create.output).toContain('created scope "marketplace-work"');
    const list = await handler({ source: "cli", args: ["list"] });
    expect(list.ok).toBe(true);
    expect(list.output).toContain("marketplace-work");
    expect(list.output).toContain("mawjs,mawjs-plugin,security");
  });

  test("create without --members → error", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const res = await handler({ source: "cli", args: ["create", "lonely"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("--members");
  });

  test("create duplicate via dispatcher → error", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const first = await handler({ source: "cli", args: ["create", "dup", "--members", "a"] });
    expect(first.ok).toBe(true);
    const second = await handler({ source: "cli", args: ["create", "dup", "--members", "b"] });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already exists");
  });

  test("show non-existent → error", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const res = await handler({ source: "cli", args: ["show", "ghost"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  test("show known scope → JSON output", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    await handler({ source: "cli", args: ["create", "viewme", "--members", "alpha"] });
    const res = await handler({ source: "cli", args: ["show", "viewme"] });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output!);
    expect(parsed.name).toBe("viewme");
    expect(parsed.members).toEqual(["alpha"]);
  });

  test("delete refuses without --yes", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    await handler({ source: "cli", args: ["create", "kill", "--members", "a"] });
    const res = await handler({ source: "cli", args: ["delete", "kill"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("--yes");
  });

  test("delete with --yes removes the file", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    await handler({ source: "cli", args: ["create", "kill", "--members", "a"] });
    const res = await handler({ source: "cli", args: ["delete", "kill", "--yes"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('deleted scope "kill"');
    const list = await handler({ source: "cli", args: ["list"] });
    expect(list.output).toContain("no scopes");
  });

  test("delete missing scope with --yes is idempotent (no-op)", async () => {
    const { default: handler } = await import("../../src/commands/plugins/scope/index");
    const res = await handler({ source: "cli", args: ["delete", "ghost", "--yes"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("no-op");
  });
});
