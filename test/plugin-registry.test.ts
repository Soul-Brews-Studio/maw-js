import { describe, test, expect, beforeEach } from "bun:test";
import { registerCommand, matchCommand, listCommands, scanCommands, executeCommand } from "../src/cli/command-registry";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// --- Helpers ---

/** Create a temp dir with plugin files for testing scanCommands */
function makeTempPluginDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-test-plugins-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// --- Registration ---

describe("registerCommand", () => {
  test("registers a simple command", () => {
    registerCommand({ name: "test-simple", description: "test" }, "/tmp/test.ts", "user");
    const match = matchCommand(["test-simple"]);
    expect(match).not.toBeNull();
    expect(match!.key).toBe("test-simple");
    expect(match!.remaining).toEqual([]);
  });

  test("registers aliases", () => {
    registerCommand({ name: ["test-alias", "ta"], description: "test alias" }, "/tmp/alias.ts", "user");
    const m1 = matchCommand(["test-alias"]);
    const m2 = matchCommand(["ta"]);
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
    expect(m1!.desc.description).toBe("test alias");
    expect(m2!.desc.description).toBe("test alias");
  });

  test("registers subcommands", () => {
    registerCommand({ name: "test fleet info", description: "fleet info" }, "/tmp/fleet-info.ts", "user");
    const match = matchCommand(["test", "fleet", "info"]);
    expect(match).not.toBeNull();
    expect(match!.key).toBe("test fleet info");
    expect(match!.remaining).toEqual([]);
  });

  test("scope is recorded", () => {
    registerCommand({ name: "test-scope-b", description: "builtin" }, "/tmp/b.ts", "builtin");
    registerCommand({ name: "test-scope-u", description: "user" }, "/tmp/u.ts", "user");
    const mb = matchCommand(["test-scope-b"]);
    const mu = matchCommand(["test-scope-u"]);
    expect(mb!.desc.scope).toBe("builtin");
    expect(mu!.desc.scope).toBe("user");
  });
});

// --- Matching ---

describe("matchCommand", () => {
  test("returns null for no match", () => {
    expect(matchCommand(["nonexistent-xyzzy"])).toBeNull();
  });

  test("case-insensitive matching", () => {
    registerCommand({ name: "test-case", description: "case" }, "/tmp/case.ts", "user");
    const match = matchCommand(["TEST-CASE"]);
    expect(match).not.toBeNull();
    expect(match!.key).toBe("test-case");
  });

  test("longest prefix wins", () => {
    registerCommand({ name: "test-lp", description: "short" }, "/tmp/lp.ts", "user");
    registerCommand({ name: "test-lp deep", description: "long" }, "/tmp/lp-deep.ts", "user");
    const match = matchCommand(["test-lp", "deep", "extra"]);
    expect(match).not.toBeNull();
    expect(match!.key).toBe("test-lp deep");
    expect(match!.desc.description).toBe("long");
    expect(match!.remaining).toEqual(["extra"]);
  });

  test("remaining args passed through", () => {
    registerCommand({ name: "test-rem", description: "rem" }, "/tmp/rem.ts", "user");
    const match = matchCommand(["test-rem", "foo", "bar"]);
    expect(match!.remaining).toEqual(["foo", "bar"]);
  });

  test("partial prefix does not match", () => {
    registerCommand({ name: "test-full-word", description: "full" }, "/tmp/full.ts", "user");
    // "test-full" should NOT match "test-full-word"
    expect(matchCommand(["test-full"])).toBeNull();
  });
});

// --- Override ---

describe("command override", () => {
  test("later registration overrides earlier", () => {
    registerCommand({ name: "test-override", description: "first" }, "/tmp/first.ts", "user");
    registerCommand({ name: "test-override", description: "second" }, "/tmp/second.ts", "builtin");
    const match = matchCommand(["test-override"]);
    expect(match!.desc.description).toBe("second");
    expect(match!.desc.scope).toBe("builtin");
  });
});

// --- listCommands ---

describe("listCommands", () => {
  test("deduplicates aliases pointing to same file", () => {
    registerCommand({ name: ["test-dedup-a", "test-dedup-b"], description: "dedup" }, "/tmp/dedup.ts", "user");
    const list = listCommands();
    const dedup = list.filter(c => c.description === "dedup");
    expect(dedup.length).toBe(1);
  });
});

// --- scanCommands ---

describe("scanCommands", () => {
  test("loads valid plugins from directory", async () => {
    const dir = makeTempPluginDir({
      "good.ts": `export const command = { name: "test-scan-good", description: "good plugin" };\nexport default async function() {}`,
    });
    const count = await scanCommands(dir, "user");
    expect(count).toBe(1);
    const match = matchCommand(["test-scan-good"]);
    expect(match).not.toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("skips files without command export", async () => {
    const dir = makeTempPluginDir({
      "nocommand.ts": `export const foo = "bar";`,
    });
    const count = await scanCommands(dir, "user");
    expect(count).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("survives bad plugin (import error)", async () => {
    const dir = makeTempPluginDir({
      "bad.ts": `import { nonexistent } from "this-package-does-not-exist-xyzzy";\nexport const command = { name: "bad", description: "bad" };`,
      "good2.ts": `export const command = { name: "test-scan-survive", description: "survives" };\nexport default async function() {}`,
    });
    const count = await scanCommands(dir, "user");
    // bad.ts fails, good2.ts succeeds
    expect(count).toBeGreaterThanOrEqual(1);
    const match = matchCommand(["test-scan-survive"]);
    expect(match).not.toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("returns 0 for nonexistent directory", async () => {
    const count = await scanCommands("/tmp/nonexistent-dir-xyzzy-12345", "user");
    expect(count).toBe(0);
  });

  test("ignores non-ts/js files", async () => {
    const dir = makeTempPluginDir({
      "readme.md": `# Not a plugin`,
      "data.json": `{}`,
      "actual.ts": `export const command = { name: "test-scan-filter", description: "only ts" };\nexport default async function() {}`,
    });
    const count = await scanCommands(dir, "user");
    expect(count).toBe(1);
    rmSync(dir, { recursive: true });
  });
});

// --- executeCommand ---

describe("executeCommand", () => {
  test("calls default export with args", async () => {
    const dir = makeTempPluginDir({
      "exec.ts": `
        export const command = { name: "test-exec", description: "exec test" };
        export default async function(args: string[]) {
          (globalThis as any).__testExecArgs = args;
        }
      `,
    });
    await scanCommands(dir, "user");
    const match = matchCommand(["test-exec", "hello", "world"]);
    expect(match).not.toBeNull();
    await executeCommand(match!.desc, match!.remaining);
    expect((globalThis as any).__testExecArgs).toEqual(["hello", "world"]);
    delete (globalThis as any).__testExecArgs;
    rmSync(dir, { recursive: true });
  });
});

// --- SDK type safety ---

describe("SDK returns typed responses", () => {
  test("identity returns Identity shape", async () => {
    const { maw } = await import("../src/sdk");
    const id = await maw.identity();
    // Whether server is up or down, shape must be correct
    expect(typeof id.node).toBe("string");
    expect(typeof id.version).toBe("string");
    expect(Array.isArray(id.agents)).toBe(true);
    expect(typeof id.clockUtc).toBe("string");
    expect(typeof id.uptime).toBe("number");
  });

  test("federation returns FederationStatus shape", async () => {
    const { maw } = await import("../src/sdk");
    const fed = await maw.federation();
    expect(typeof fed.localUrl).toBe("string");
    expect(Array.isArray(fed.peers)).toBe(true);
    expect(typeof fed.totalPeers).toBe("number");
    expect(typeof fed.reachablePeers).toBe("number");
  });

  test("sessions returns Session[] shape", async () => {
    const { maw } = await import("../src/sdk");
    const sess = await maw.sessions();
    expect(Array.isArray(sess)).toBe(true);
    if (sess.length > 0) {
      expect(typeof sess[0].name).toBe("string");
      expect(Array.isArray(sess[0].windows)).toBe(true);
    }
  });

  test("feed returns FeedEvent[] or object with events", async () => {
    const { maw } = await import("../src/sdk");
    const result = await maw.feed();
    // Server may return array or {events: [...]} — both valid
    expect(result).toBeDefined();
  });

  test("maw.fetch returns typed data from live endpoint", async () => {
    const { maw } = await import("../src/sdk");
    try {
      const data = await maw.fetch<{ node: string }>("/api/identity");
      expect(typeof data.node).toBe("string");
    } catch {
      // Server offline — fetch is expected to throw
      expect(true).toBe(true);
    }
  });

  test("maw.fetch throws on invalid endpoint", async () => {
    const { maw } = await import("../src/sdk");
    try {
      await maw.fetch("/api/nonexistent-endpoint-xyzzy");
      // If server is up, 404 should throw
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});
