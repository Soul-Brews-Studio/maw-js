/**
 * maw peers — unit tests (#568).
 *
 * Each test points PEERS_FILE at a unique tmp path so they are
 * hermetic and parallel-safe. We exercise the impl layer directly
 * (add/list/info/remove/validation/atomic-write) plus a thin
 * end-to-end pass through the index.ts dispatcher.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-peers-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

describe("peers impl", () => {
  it("validateAlias accepts lowercase + digits + -/_ up to 32 chars", async () => {
    const { validateAlias } = await import("./impl");
    expect(validateAlias("w")).toBeNull();
    expect(validateAlias("white-01")).toBeNull();
    expect(validateAlias("node_a")).toBeNull();
    expect(validateAlias("")).not.toBeNull();
    expect(validateAlias("-bad")).not.toBeNull();
    expect(validateAlias("BAD")).not.toBeNull();
    expect(validateAlias("a".repeat(33))).not.toBeNull();
  });

  it("validateUrl requires http(s)", async () => {
    const { validateUrl } = await import("./impl");
    expect(validateUrl("http://x.local:3456")).toBeNull();
    expect(validateUrl("https://x.local")).toBeNull();
    expect(validateUrl("ftp://x.local")).not.toBeNull();
    expect(validateUrl("notaurl")).not.toBeNull();
  });

  it("add → list shows the peer", async () => {
    const { cmdAdd, cmdList } = await import("./impl");
    await cmdAdd({ alias: "w", url: "http://white.local:3456", node: "white" });
    const rows = cmdList();
    expect(rows).toHaveLength(1);
    expect(rows[0].alias).toBe("w");
    expect(rows[0].url).toBe("http://white.local:3456");
    expect(rows[0].node).toBe("white");
  });

  it("add rejects invalid alias", async () => {
    const { cmdAdd } = await import("./impl");
    await expect(cmdAdd({ alias: "BAD!", url: "http://x", node: "x" }))
      .rejects.toThrow(/invalid alias/);
  });

  it("add rejects invalid URL", async () => {
    const { cmdAdd } = await import("./impl");
    await expect(cmdAdd({ alias: "x", url: "notaurl", node: "x" }))
      .rejects.toThrow(/invalid URL/);
  });

  it("add over existing alias overwrites and reports it", async () => {
    const { cmdAdd } = await import("./impl");
    const first = await cmdAdd({ alias: "w", url: "http://a.local", node: "a" });
    expect(first.overwrote).toBe(false);
    const second = await cmdAdd({ alias: "w", url: "http://b.local", node: "b" });
    expect(second.overwrote).toBe(true);
    expect(second.peer.url).toBe("http://b.local");
  });

  it("remove existing returns true and list drops it", async () => {
    const { cmdAdd, cmdRemove, cmdList } = await import("./impl");
    await cmdAdd({ alias: "w", url: "http://w.local", node: "w" });
    expect(cmdRemove("w")).toBe(true);
    expect(cmdList()).toHaveLength(0);
  });

  it("remove non-existent is idempotent (returns false, no throw)", async () => {
    const { cmdRemove } = await import("./impl");
    expect(cmdRemove("ghost")).toBe(false);
  });

  it("info returns entry for known alias, null for unknown", async () => {
    const { cmdAdd, cmdInfo } = await import("./impl");
    await cmdAdd({ alias: "w", url: "http://w.local", node: "w" });
    expect(cmdInfo("w")?.url).toBe("http://w.local");
    expect(cmdInfo("ghost")).toBeNull();
  });

  it("formatList renders header + rows (non-empty) or placeholder (empty)", async () => {
    const { cmdAdd, cmdList, formatList } = await import("./impl");
    expect(formatList([])).toBe("no peers");
    await cmdAdd({ alias: "w", url: "http://w.local", node: "w" });
    const out = formatList(cmdList());
    expect(out).toContain("alias");
    expect(out).toContain("w");
    expect(out).toContain("http://w.local");
  });
});

describe("peers store — atomic write crash-safety", () => {
  it("stale .tmp file from a crashed write does not corrupt load", async () => {
    const { cmdAdd } = await import("./impl");
    const { loadPeers, peersPath } = await import("./store");
    await cmdAdd({ alias: "w", url: "http://w.local", node: "w" });
    // Simulate a crash mid-write: the live file is intact, a stale .tmp exists.
    writeFileSync(peersPath() + ".tmp", "{ corrupt partial write");
    const loaded = loadPeers();
    expect(loaded.peers.w?.url).toBe("http://w.local");
  });

  it("writes go via .tmp then rename (no partial file if rename fails)", async () => {
    const { cmdAdd } = await import("./impl");
    const { peersPath } = await import("./store");
    await cmdAdd({ alias: "w", url: "http://w.local", node: "w" });
    const body = readFileSync(peersPath(), "utf-8");
    expect(body).toContain('"version"');
    expect(body).toContain('"w"');
    expect(existsSync(peersPath() + ".tmp")).toBe(false);
  });
});

describe("peers store — corruption + cleanup + lock (#572)", () => {
  it("corrupt peers.json → loadPeers returns empty + renames aside + warns", async () => {
    const { loadPeers, peersPath } = await import("./store");
    const path = peersPath();
    writeFileSync(path, "{ this is not valid json");
    const errs: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => { errs.push(String(msg)); };
    try {
      const data = loadPeers();
      expect(data.peers).toEqual({});
    } finally {
      console.error = orig;
    }
    expect(existsSync(path)).toBe(false);
    const { readdirSync } = await import("fs");
    const aside = readdirSync(dir).find(f => f.startsWith("peers.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(errs.some(e => e.includes("failed to parse"))).toBe(true);
  });

  it("stale .tmp on startup → loadPeers cleans it up", async () => {
    const { loadPeers, peersPath } = await import("./store");
    const tmp = peersPath() + ".tmp";
    writeFileSync(tmp, "leftover from a crashed write");
    expect(existsSync(tmp)).toBe(true);
    loadPeers();
    expect(existsSync(tmp)).toBe(false);
  });

  it("two concurrent addPeer promises → both aliases survive", async () => {
    const { cmdAdd, cmdList } = await import("./impl");
    const [a, b] = await Promise.all([
      cmdAdd({ alias: "alpha", url: "http://a.local", node: "a" }),
      cmdAdd({ alias: "beta", url: "http://b.local", node: "b" }),
    ]);
    expect(a.alias).toBe("alpha");
    expect(b.alias).toBe("beta");
    const rows = cmdList();
    const aliases = rows.map(r => r.alias).sort();
    expect(aliases).toEqual(["alpha", "beta"]);
  });
});

describe("peers dispatcher (index.ts)", () => {
  it("no args → prints help", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: [] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("usage: maw peers");
  });

  it("unknown subcommand → error + help in output", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: ["wat"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown subcommand");
  });

  it("add then list through dispatcher", async () => {
    const { default: handler } = await import("./index");
    const add = await handler({ source: "cli", args: ["add", "w", "http://w.local", "--node", "white"] });
    expect(add.ok).toBe(true);
    expect(add.output).toContain("added w");
    const list = await handler({ source: "cli", args: ["list"] });
    expect(list.ok).toBe(true);
    expect(list.output).toContain("w");
    expect(list.output).toContain("http://w.local");
  });

  it("remove non-existent via dispatcher is ok (no-op)", async () => {
    const { default: handler } = await import("./index");
    const res = await handler({ source: "cli", args: ["remove", "ghost"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("no-op");
  });
});
