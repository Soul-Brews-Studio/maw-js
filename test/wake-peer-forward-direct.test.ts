import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { invokeDirectHandler } from "../src/cli/top-aliases";

/**
 * Cross-node `maw wake <oracle> --peer <alias>` must FORWARD to the peer's
 * /api/wake (forwardToPeer), not spawn a local session. forwardToPeer lives in
 * the wake PLUGIN, but `wake`/`awake` dispatch through the top-aliases DIRECT
 * handler, which exits the pipeline before the plugin runs — so without this the
 * `--peer` invocation fell through to a LOCAL wake (cloning/spawning on the
 * wrong node). Same shadow seam as #wake-fresh-session (PR #12). These tests
 * lock the forward path and the oracle→task positional handoff.
 */

type Captured = { alias?: string; oracle?: string; flags?: any; localWake?: boolean; localTarget?: string };

async function run(argv: string[], forwardResult: { ok: boolean; output?: string; error?: string }): Promise<Captured> {
  const cap: Captured = { localWake: false };
  await invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", argv, {
    forwardToPeer: (alias: string, oracle: string, flags: any) => {
      cap.alias = alias; cap.oracle = oracle; cap.flags = flags;
      return forwardResult;
    },
    cmdWake: (target: string) => { cap.localWake = true; cap.localTarget = target; },
    log: () => {},
    error: () => {},
  });
  return cap;
}

describe("wake --peer forwards cross-node instead of waking locally", () => {
  test("--peer <alias> calls forwardToPeer and does NOT wake locally", async () => {
    const cap = await run(["m5-oracle", "--peer", "win"], { ok: true, output: "forwarded" });
    expect(cap.alias).toBe("win");
    expect(cap.oracle).toBe("m5-oracle");
    expect(cap.localWake).toBe(false);
  });

  test("the oracle is stripped from positionals so remote positional[0] is the task", async () => {
    const cap = await run(["m5-oracle", "build-thing", "--peer", "win"], { ok: true });
    expect(cap.oracle).toBe("m5-oracle");
    expect(cap.flags._).toEqual(["build-thing"]);
  });

  test("worktree flags ride along to the peer", async () => {
    const cap = await run(["m5-oracle", "--peer", "win", "--wt", "slug1", "--fresh"], { ok: true });
    expect(cap.flags["--wt"]).toBe("slug1");
    expect(cap.flags["--fresh"]).toBe(true);
  });

  test("a forward failure surfaces as an error (and still no local wake)", async () => {
    let threw = false;
    try {
      await run(["m5-oracle", "--peer", "nope"], { ok: false, error: "unknown peer alias: nope" });
    } catch (e: any) {
      threw = true;
      expect(String(e?.message ?? e)).toContain("unknown peer alias");
    }
    expect(threw).toBe(true);
  });

  test("no --peer → local wake (baseline), forward not called", async () => {
    const cap = await run(["m5-oracle", "--work"], { ok: true });
    expect(cap.localWake).toBe(true);
    expect(cap.alias).toBeUndefined();
  });
});

describe("no `<node>:<repo>` colon shorthand — peer wake is --peer only (Riddler r2)", () => {
  test("a `<node>:<repo>` string is a plain LOCAL target, no peer semantics", async () => {
    // The colon shorthand was removed: an unresolved prefix must not silently
    // fall through to a wrong LOCAL wake. `no-trust:TTT3P/x` is just a local
    // oracle string exactly as before this PR.
    const cap = await run(["no-trust:TTT3P/x", "--work"], { ok: true });
    expect(cap.alias).toBeUndefined();          // forwardToPeer never called
    expect(cap.localWake).toBe(true);
    expect(cap.localTarget).toBe("no-trust:TTT3P/x");
  });
});

describe("--peer with an unknown alias errors with ZERO local cmdWake (real forwardToPeer)", () => {
  const dir = mkdtempSync(join(tmpdir(), "peerwake-unknown-"));
  const peersFile = join(dir, "peers.json");
  writeFileSync(peersFile, JSON.stringify({ peers: {} })); // no aliases
  const prev = process.env.PEERS_FILE;
  process.env.PEERS_FILE = peersFile;
  afterAll(() => {
    if (prev === undefined) delete process.env.PEERS_FILE; else process.env.PEERS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("`--peer unknown` → error, and cmdWake (local) is never called", async () => {
    let localWake = false;
    let threw = false;
    try {
      await invokeDirectHandler("../commands/shared/wake-cmd:cmdWake",
        ["m5-oracle", "--peer", "unknown", "--work"],
        { cmdWake: () => { localWake = true; }, log: () => {}, error: () => {} });
    } catch (e: any) {
      threw = true;
      expect(String(e?.message ?? e)).toContain("unknown peer alias");
    }
    expect(threw).toBe(true);
    expect(localWake).toBe(false);
  });
});
