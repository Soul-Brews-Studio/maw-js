/**
 * `maw init` wizard — unit tests for the impl layer (#455).
 *
 * Isolated (per-file subprocess) because we set MAW_CONFIG_DIR before
 * the first import of src/core/paths.ts — that module performs a top-level
 * mkdirSync of FLEET_DIR, so the env var must be present at import time.
 *
 * Subprocess CLI tests live in test/init-wizard-subprocess.test.ts (paired
 * teammate). This file exercises the in-process cmdInit() entry point with
 * an injected ask function — no /dev/tty, no real stdin.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-init-455-"));
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
// #680: init now bootstraps plugins.lock — isolate from user's real ~/.maw.
process.env.MAW_PLUGINS_LOCK = join(TEST_CONFIG_DIR, "plugins.lock");

let cmdInit: typeof import("../../src/commands/plugins/init/impl").cmdInit;
let CONFIG_FILE: string;

beforeAll(async () => {
  const paths = await import("../../src/core/paths");
  CONFIG_FILE = paths.CONFIG_FILE;
  ({ cmdInit } = await import("../../src/commands/plugins/init/impl"));
});

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

function clearConfig() {
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
  for (const f of readdirSync(TEST_CONFIG_DIR)) {
    if (f.startsWith("maw.config.json.bak.")) rmSync(join(TEST_CONFIG_DIR, f));
  }
}

/** Build a scripted ask fn from a queue of answers. Throws if exhausted. */
function scriptedAsk(answers: Record<string, string | string[]> | string[]): (q: string, def?: string) => Promise<string> {
  if (Array.isArray(answers)) {
    let i = 0;
    return async () => {
      if (i >= answers.length) throw new Error(`scriptedAsk: ran out of answers at index ${i}`);
      return answers[i++];
    };
  }
  const indices: Record<string, number> = {};
  return async (question: string) => {
    for (const key of Object.keys(answers)) {
      if (question.includes(key)) {
        const a = answers[key];
        if (Array.isArray(a)) {
          indices[key] = (indices[key] ?? 0);
          const v = a[indices[key]++];
          if (v === undefined) throw new Error(`scriptedAsk: out of answers for "${key}"`);
          return v;
        }
        return a;
      }
    }
    throw new Error(`scriptedAsk: no scripted answer for "${question}"`);
  };
}

describe("cmdInit non-interactive", () => {
  test("T5 — happy path with all flags writes minimal config", async () => {
    clearConfig();
    const out: string[] = [];
    const result = await cmdInit({
      args: ["--non-interactive", "--node", "ci-node", "--ghq-root", "/tmp/code", "--force"],
      writer: (m) => out.push(m),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(CONFIG_FILE)).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // #906 — host is the SSH connection target ("local" by default), NOT
    // the node identity. Pre-#906 this asserted `cfg.host === "ci-node"`
    // which is exactly the bug — `hostExec` would then `ssh ci-node …` on
    // every fleet-pinned clone.
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("ci-node");
    expect(cfg.ghqRoot).toBe("/tmp/code");
    expect(cfg.port).toBe(3456);
    expect(cfg.commands.default).toContain("claude");
    expect(cfg.federationToken).toBeUndefined();
  });

  test("T6 — existing config without --force returns error", async () => {
    // file persists from T5
    expect(existsSync(CONFIG_FILE)).toBe(true);
    const result = await cmdInit({
      args: ["--non-interactive", "--node", "other"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--force");
  });

  test("federation flags generate a 64-char hex token + namedPeers", async () => {
    clearConfig();
    const result = await cmdInit({
      args: [
        "--non-interactive",
        "--node", "white",
        "--ghq-root", "/tmp/code",
        "--federate",
        "--peer", "http://10.0.0.1:3456",
        "--peer-name", "mba",
        "--peer", "http://10.0.0.2:3456",
        "--force",
      ],
      writer: () => {},
    });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    expect(cfg.namedPeers).toEqual([
      { name: "mba", url: "http://10.0.0.1:3456" },
      { name: "peer-2", url: "http://10.0.0.2:3456" },
    ]);
    expect(cfg.federationToken).toMatch(/^[a-f0-9]{64}$/);
  });

  test("explicit --federation-token is preserved verbatim", async () => {
    clearConfig();
    const explicit = "deadbeef".repeat(8);
    const result = await cmdInit({
      args: [
        "--non-interactive",
        "--node", "white",
        "--ghq-root", "/tmp/code",
        "--federate",
        "--federation-token", explicit,
        "--force",
      ],
      writer: () => {},
    });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    expect(cfg.federationToken).toBe(explicit);
  });

  test("invalid node name returns error (no prompt re-loop)", async () => {
    clearConfig();
    const result = await cmdInit({
      args: ["--non-interactive", "--node", "bad name", "--force"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Node name");
  });

  test("relative ghq-root rejected", async () => {
    clearConfig();
    const result = await cmdInit({
      args: ["--non-interactive", "--node", "ci", "--ghq-root", "relative/path", "--force"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("absolute");
  });

  test("invalid peer URL rejected with index", async () => {
    clearConfig();
    const result = await cmdInit({
      args: [
        "--non-interactive",
        "--node", "ci",
        "--ghq-root", "/tmp/code",
        "--peer", "10.0.0.1:3456",
        "--peer-name", "white",
        "--force",
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--peer #1");
  });
});

describe("cmdInit interactive (scripted ask)", () => {
  test("T1 — happy path no federation, no token", async () => {
    clearConfig();
    const ask = scriptedAsk({
      "Node name": "white",
      "Code root": "/home/nat/Code",
      "Claude token": "",
      "Federate": "n",
    });
    const result = await cmdInit({ args: [], ask, writer: () => {} });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // #906 — host is the SSH target ("local"); node is the identity ("white").
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("white");
    // #680 — ghqRoot is no longer prompted/persisted; resolved on demand via getGhqRoot().
    expect(cfg.ghqRoot).toBeUndefined();
    expect(cfg.env).toEqual({});
    expect(cfg.federationToken).toBeUndefined();
    expect(cfg.namedPeers).toBeUndefined();
  });

  test("T2 — federation with one peer prints token + writes namedPeers", async () => {
    clearConfig();
    const out: string[] = [];
    let peerStep = 0;
    const ask = async (q: string, def?: string) => {
      if (q.includes("Node name")) return "white";
      if (q.includes("Code root")) return "/home/nat/Code";
      if (q.includes("Claude token")) return "";
      if (q.includes("Federate")) return "y";
      if (q.includes("Peer 1 URL")) {
        peerStep++;
        return peerStep === 1 ? "http://10.0.0.1:3456" : "done";
      }
      if (q.includes("Peer 1 name")) return "mba";
      if (q.includes("Peer 2 URL")) return "done";
      throw new Error(`unexpected: ${q}`);
    };
    const result = await cmdInit({ args: [], ask, writer: (m) => out.push(m) });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    expect(cfg.namedPeers).toEqual([{ name: "mba", url: "http://10.0.0.1:3456" }]);
    expect(cfg.federationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(out.some((l) => l.includes("federation token") || l.includes(cfg.federationToken))).toBe(true);
  });

  test("T3 — existing config + abort default leaves file untouched", async () => {
    // ensure a config exists with a known marker
    writeFileSync(CONFIG_FILE, JSON.stringify({ host: "preserved-marker", port: 3456, ghqRoot: "/keep", oracleUrl: "http://localhost:47779", env: {}, commands: { default: "claude" }, sessions: {} }, null, 2));
    const out: string[] = [];
    const ask = async () => ""; // blank → abort default
    const result = await cmdInit({ args: [], ask, writer: (m) => out.push(m) });
    expect(result.ok).toBe(true);
    expect(out.some((l) => l.toLowerCase().includes("aborted"))).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    expect(cfg.host).toBe("preserved-marker");
  });

  test("T4 — existing config + 'o' overwrites in place", async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ host: "old", port: 3456, ghqRoot: "/keep", oracleUrl: "x", env: {}, commands: { default: "claude" }, sessions: {} }, null, 2));
    let asked = 0;
    const ask = async (q: string) => {
      asked++;
      if (asked === 1) return "o"; // existing-config choice
      if (q.includes("Node name")) return "fresh";
      if (q.includes("Code root")) return "/home/nat/Code";
      if (q.includes("Claude token")) return "";
      if (q.includes("Federate")) return "n";
      throw new Error(`unexpected: ${q}`);
    };
    const result = await cmdInit({ args: [], ask, writer: () => {} });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // #906 — host=local; node=fresh.
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("fresh");
  });

  test("backup option writes maw.config.json.bak.<ts> before overwrite", async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ host: "backup-marker", port: 3456, ghqRoot: "/k", oracleUrl: "x", env: {}, commands: { default: "claude" }, sessions: {} }, null, 2));
    let asked = 0;
    const ask = async (q: string) => {
      asked++;
      if (asked === 1) return "b"; // backup
      if (q.includes("Node name")) return "after";
      if (q.includes("Code root")) return "/home/nat/Code";
      if (q.includes("Claude token")) return "";
      if (q.includes("Federate")) return "n";
      throw new Error(`unexpected: ${q}`);
    };
    const result = await cmdInit({ args: [], ask, writer: () => {} });
    expect(result.ok).toBe(true);
    const baks = readdirSync(TEST_CONFIG_DIR).filter((f) => f.startsWith("maw.config.json.bak."));
    expect(baks.length).toBeGreaterThan(0);
    const restored = JSON.parse(readFileSync(join(TEST_CONFIG_DIR, baks[0]), "utf-8"));
    expect(restored.host).toBe("backup-marker");
  });

  test("T7 — invalid node name re-prompts then accepts", async () => {
    clearConfig();
    let nodeAttempts = 0;
    const ask = async (q: string) => {
      if (q.includes("Node name")) {
        nodeAttempts++;
        return nodeAttempts === 1 ? "my oracle" : "myoracle";
      }
      if (q.includes("Code root")) return "/tmp/code";
      if (q.includes("Claude token")) return "";
      if (q.includes("Federate")) return "n";
      throw new Error(`unexpected: ${q}`);
    };
    const out: string[] = [];
    const result = await cmdInit({ args: [], ask, writer: (m) => out.push(m) });
    expect(result.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // #906 — host=local; node=myoracle.
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("myoracle");
    expect(out.some((l) => l.includes("Node name must be"))).toBe(true);
  });
});
