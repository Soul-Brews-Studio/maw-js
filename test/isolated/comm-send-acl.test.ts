/**
 * comm-send-acl — ACL gate integration tests (#842 Sub-C).
 *
 * Verifies that `cmdSend` consults `evaluateAclFromDisk` for cross-node
 * (peer) targets and either:
 *
 *   - allows the send (no scopes / sender+target share scope / trusted)
 *   - queues the send under <CONFIG_DIR>/pending/ ("queue" verdict)
 *
 * Default-allow when scopes are empty is critical — Sub-C must not break
 * existing setups that haven't migrated to scopes yet.
 *
 * The federation HTTP layer is mocked at `sdk` so no real requests fire.
 * We assert on the queue-store side effects + the curlFetch call count.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

let testDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;
let curlCalls: Array<{ url: string }> = [];
let configReturn: () => any = () => ({ node: "white", oracle: "mawjs", port: 3456, namedPeers: [{ name: "phaith", url: "http://phaith:3456" }] });

const _rSdk = await import("../../src/sdk");

mock.module(join(srcRoot, "src/sdk"), () => ({
  ..._rSdk,
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "claude",
  listSessions: async () => [],
  findPeerForTarget: async () => null,
  curlFetch: async (url: string) => {
    curlCalls.push({ url });
    return { ok: true, status: 200, data: { ok: true, target: "hojo" } };
  },
  runHook: async () => {},
  hostExec: async () => "",
}));

mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => configReturn()),
);

mock.module(join(srcRoot, "src/core/routing"), () => ({
  resolveTarget: () => ({
    type: "peer",
    target: "hojo",
    node: "phaith",
    peerUrl: "http://phaith:3456",
  }),
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  logMessage: () => {},
  emitFeed: () => {},
}));

mock.module(join(srcRoot, "src/commands/shared/wake-cmd"), () => ({
  cmdWake: async () => {},
}));

const origSleep = Bun.sleep.bind(Bun);
(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

const { cmdSend } = await import("../../src/commands/shared/comm-send");

const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
let exitCode: number | undefined;
let outs: string[] = [];

async function run(fn: () => Promise<unknown>): Promise<void> {
  exitCode = undefined; outs = [];
  console.error = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { await fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.error = origErr;
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "maw-comm-acl-"));
  originalConfigDir = process.env.MAW_CONFIG_DIR;
  originalHome = process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = testDir;
  delete process.env.MAW_HOME;
  delete process.env.MAW_ACL_BYPASS;
  process.env.MAW_QUIET = "1";
  curlCalls = [];
  configReturn = () => ({
    node: "white",
    oracle: "mawjs",
    port: 3456,
    namedPeers: [{ name: "phaith", url: "http://phaith:3456" }],
  });
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalHome;
  delete process.env.MAW_ACL_BYPASS;
  delete process.env.MAW_QUIET;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeScope(name: string, members: string[]) {
  const dir = join(testDir, "scopes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ name, members, created: new Date().toISOString(), ttl: null }),
  );
}

function writeTrust(entries: { sender: string; target: string }[]) {
  writeFileSync(
    join(testDir, "trust.json"),
    JSON.stringify(entries.map(e => ({ ...e, addedAt: new Date().toISOString() }))),
  );
}

describe("comm-send ACL gate — default-allow", () => {
  test("no scopes defined → send proceeds (default-allow)", async () => {
    await run(() => cmdSend("phaith:hojo", "hi"));
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(true);
    expect(exitCode).toBeUndefined();
  });

  test("no scopes defined → no pending file written", async () => {
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    await run(() => cmdSend("phaith:hojo", "hi"));
    expect(loadPending()).toEqual([]);
  });
});

describe("comm-send ACL gate — allow paths", () => {
  test("sender + target share a scope → send proceeds", async () => {
    writeScope("market", ["mawjs", "hojo"]);
    await run(() => cmdSend("phaith:hojo", "hi"));
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(true);
  });

  test("trust entry covers the pair → send proceeds", async () => {
    writeScope("market", ["other"]); // forces ACL evaluation (non-empty)
    writeTrust([{ sender: "mawjs", target: "hojo" }]);
    await run(() => cmdSend("phaith:hojo", "hi"));
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(true);
  });

  test("symmetric trust — {hojo, mawjs} grants mawjs → hojo too", async () => {
    writeScope("market", ["other"]);
    writeTrust([{ sender: "hojo", target: "mawjs" }]);
    await run(() => cmdSend("phaith:hojo", "hi"));
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(true);
  });
});

describe("comm-send ACL gate — queue paths", () => {
  test("scopes defined but pair not allowed → queue + no /api/send", async () => {
    writeScope("market", ["other"]);
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    await run(() => cmdSend("phaith:hojo", "hi"));
    const list = loadPending();
    expect(list).toHaveLength(1);
    expect(list[0].sender).toBe("mawjs");
    expect(list[0].target).toBe("hojo");
    expect(list[0].message).toBe("hi");
    expect(list[0].query).toBe("phaith:hojo");
    // No federation send should have happened.
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(false);
  });

  test("queued message includes the original query for re-issue on approve", async () => {
    writeScope("market", ["other"]);
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    await run(() => cmdSend("phaith:hojo", "deferred"));
    const [m] = loadPending();
    expect(m.query).toBe("phaith:hojo");
  });
});

describe("comm-send ACL gate — bypass paths", () => {
  test("MAW_ACL_BYPASS=1 → send proceeds even with scope deny", async () => {
    writeScope("market", ["other"]);
    process.env.MAW_ACL_BYPASS = "1";
    await run(() => cmdSend("phaith:hojo", "hi"));
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(true);
    delete process.env.MAW_ACL_BYPASS;
  });

  test("--approve opts (cmdSend opts.approve) → send proceeds even with scope deny", async () => {
    writeScope("market", ["other"]);
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    await run(() => cmdSend("phaith:hojo", "hi", false, { approve: true }));
    expect(curlCalls.some(c => c.url.includes("/api/send"))).toBe(true);
    expect(loadPending()).toEqual([]);
  });

  test("--approve --trust persists the pair to trust.json", async () => {
    writeScope("market", ["other"]);
    await run(() => cmdSend("phaith:hojo", "hi", false, { approve: true, trust: true }));
    const { loadTrust } = await import("../../src/commands/plugins/trust/store");
    const list = loadTrust();
    expect(list).toHaveLength(1);
    expect(list[0].sender).toBe("mawjs");
    expect(list[0].target).toBe("hojo");
  });
});

describe("comm-send ACL gate — oracle name resolution", () => {
  test("uses config.oracle for sender (not config.node)", async () => {
    configReturn = () => ({
      node: "white",
      oracle: "weave",
      port: 3456,
      namedPeers: [{ name: "phaith", url: "http://phaith:3456" }],
    });
    writeScope("dummy", ["other"]);
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    await run(() => cmdSend("phaith:hojo", "hi"));
    const [m] = loadPending();
    expect(m.sender).toBe("weave");
  });

  test("falls back to 'mawjs' when config.oracle is unset", async () => {
    configReturn = () => ({
      node: "white",
      port: 3456,
      namedPeers: [{ name: "phaith", url: "http://phaith:3456" }],
    });
    writeScope("dummy", ["other"]);
    const { loadPending } = await import("../../src/commands/shared/queue-store");
    await run(() => cmdSend("phaith:hojo", "hi"));
    const [m] = loadPending();
    expect(m.sender).toBe("mawjs");
  });
});
