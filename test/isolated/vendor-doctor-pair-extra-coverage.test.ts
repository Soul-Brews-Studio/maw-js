/** Extra isolated branch coverage for vendor doctor + pair peer internals. */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "child_process";
import * as realFs from "fs";

const C = { green: "", red: "", yellow: "", gray: "", reset: "" };
const DOCTOR_HOME = "/tmp/vendor-doctor-pair-extra-home";
const DOCTOR_BIN = `${DOCTOR_HOME}/.bun/bin/maw`;

let logs: string[] = [];
let execCalls: string[] = [];
let installMode: "present-plain" | "missing-then-restored" | "missing-still-missing" | "missing-exec-fails" = "present-plain";
let pm2Jlist: string | Error | null = null;
let sourcePackageMode: "ok" | "missing-version" | "throw" = "ok";
let fetchMode: "aligned" | "non-ok" | "throws" | "bad-json" = "aligned";
let peersStore: Record<string, any> = {};
let loadPeersError: Error | null = null;
let configValue: any = { oracle: "local-oracle", node: "local-node" };
let configError: Error | null = null;
let staleCheck = { name: "peers:stale", ok: true, message: "no stale peers" };
let branchCheck = { name: "maw-js:branch", ok: true, message: "on alpha" };
let worktreeCheck = { name: "worktrees:stillborn", ok: true, message: "none" };
let manifestValue: any[] = [];
let manifestError: Error | null = null;
let invalidateCalls = 0;

const originalLog = console.log;
const originalFetch = globalThis.fetch;
const originalResolveSync = Bun.resolveSync;
const originalSpawn = Bun.spawn;

mock.module("os", () => ({ homedir: () => DOCTOR_HOME }));

mock.module("child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    if (cmd === "pm2 jlist 2>/dev/null") {
      if (pm2Jlist instanceof Error) throw pm2Jlist;
      return pm2Jlist ?? "[]";
    }
    if (cmd === "bun add -g github:Soul-Brews-Studio/maw-js") {
      if (installMode === "missing-exec-fails") throw new Error("install boom");
      return "";
    }
    throw new Error(`unexpected execSync: ${cmd}`);
  },
}));

mock.module("fs", () => ({
  ...realFs,
  existsSync: (path: string) => {
    if (path === DOCTOR_BIN) {
      if (installMode === "present-plain") return true;
      return execCalls.includes("bun add -g github:Soul-Brews-Studio/maw-js")
        && installMode === "missing-then-restored";
    }
    return true;
  },
  readlinkSync: (path: string) => {
    if (path === DOCTOR_BIN && installMode === "present-plain") throw new Error("not a symlink");
    return realFs.readlinkSync(path);
  },
  readFileSync: (path: string, encoding?: BufferEncoding) => {
    if (String(path).endsWith("/package.json")) {
      if (sourcePackageMode === "throw") throw new Error("package unreadable");
      if (sourcePackageMode === "missing-version") return JSON.stringify({ name: "maw-js" });
      return JSON.stringify({ version: "1.2.3-test" });
    }
    return realFs.readFileSync(path, encoding);
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => {
    if (configError) throw configError;
    return configValue;
  },
}));

mock.module("maw-js/commands/shared/fleet-doctor-fixer", () => ({ C }));

mock.module("maw-js/lib/oracle-manifest", () => ({
  invalidateManifest: () => { invalidateCalls += 1; },
  loadManifestCached: () => {
    if (manifestError) throw manifestError;
    return manifestValue;
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/peers-store"), () => ({
  loadPeers: () => {
    if (loadPeersError) throw loadPeersError;
    return { version: 1, peers: peersStore };
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stale-peers"), () => ({
  checkStalePeers: () => staleCheck,
  cmdFixStalePeers: async () => ({ ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: "noop" }] }),
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/maw-js-branch-check"), () => ({
  checkMawJsBranch: async () => branchCheck,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/stillborn-worktrees"), () => ({
  checkStillbornWorktrees: () => worktreeCheck,
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/internal/bun-link-detect"), () => ({
  detectBunLinkedCheckout: () => null,
}));

const doctorModule = await import("../../src/vendor/mpr-plugins/doctor/impl.ts?vendor-doctor-pair-extra-doctor");

beforeEach(() => {
  logs = [];
  execCalls = [];
  installMode = "present-plain";
  pm2Jlist = null;
  sourcePackageMode = "ok";
  fetchMode = "aligned";
  peersStore = {};
  loadPeersError = null;
  configValue = { oracle: "local-oracle", node: "local-node" };
  configError = null;
  staleCheck = { name: "peers:stale", ok: true, message: "no stale peers" };
  branchCheck = { name: "maw-js:branch", ok: true, message: "on alpha" };
  worktreeCheck = { name: "worktrees:stillborn", ok: true, message: "none" };
  manifestValue = [];
  manifestError = null;
  invalidateCalls = 0;
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
  (Bun as unknown as { resolveSync: typeof Bun.resolveSync }).resolveSync = ((specifier: string) => {
    if (specifier === "maw-js/package.json") return "/virtual/maw-js/package.json";
    return originalResolveSync(specifier, import.meta.dir);
  }) as typeof Bun.resolveSync;
  globalThis.fetch = (async () => {
    if (fetchMode === "throws") throw new Error("network boom");
    if (fetchMode === "bad-json") return { ok: true, json: async () => { throw new Error("json boom"); } } as Response;
    if (fetchMode === "non-ok") return { ok: false, json: async () => ({ version: "ignored" }) } as Response;
    return { ok: true, json: async () => ({ version: "1.2.3-test" }) } as Response;
  }) as typeof fetch;
  delete process.env.MAW_PORT;
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  (Bun as unknown as { resolveSync: typeof Bun.resolveSync }).resolveSync = originalResolveSync;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
  delete process.env.MAW_PORT;
});

function fakeProc(code: number, stdout = "", stderr = "") {
  return {
    exited: Promise.resolve(code),
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("doctor impl extra branch coverage", () => {
  test("install reinstall paths report restored, missing-after-install, and thrown failures", async () => {
    installMode = "missing-then-restored";
    const restored = await doctorModule.cmdDoctor(["install"]);
    expect(restored.ok).toBe(true);
    expect(restored.checks[0]).toEqual({
      name: "install",
      ok: true,
      message: "reinstalled from github:Soul-Brews-Studio/maw-js",
    });

    execCalls = [];
    installMode = "missing-still-missing";
    const stillMissing = await doctorModule.cmdDoctor(["install"]);
    expect(stillMissing.ok).toBe(false);
    expect(stillMissing.checks[0]?.message).toBe("reinstall did not produce the binary — manual intervention needed");

    execCalls = [];
    installMode = "missing-exec-fails";
    const failed = await doctorModule.cmdDoctor(["install"]);
    expect(failed.ok).toBe(false);
    expect(failed.checks[0]?.message).toBe("reinstall failed: install boom");
  });

  test("version drift covers source, pm2 parse, process filtering, default port, and fetch failure branches", async () => {
    sourcePackageMode = "missing-version";
    expect(await doctorModule.cmdDoctor(["version"])).toMatchObject({
      ok: false,
      checks: [{ name: "version:source", ok: false }],
    });

    sourcePackageMode = "throw";
    expect((await doctorModule.cmdDoctor(["version"])).checks[0]?.message).toBe("could not read package.json version");

    sourcePackageMode = "ok";
    pm2Jlist = new Error("pm2 absent");
    expect(await doctorModule.cmdDoctor(["version"])).toMatchObject({
      ok: true,
      checks: [{ name: "version:pm2", ok: true, message: "pm2 unavailable — source 1.2.3-test (no running maw to compare)" }],
    });

    pm2Jlist = "{not-json";
    expect((await doctorModule.cmdDoctor(["version"])).checks[0]?.name).toBe("version:pm2");

    pm2Jlist = JSON.stringify({ not: "an array" });
    expect((await doctorModule.cmdDoctor(["version"])).checks[0]?.message).toBe("no running maw — source 1.2.3-test");

    pm2Jlist = JSON.stringify([
      null,
      { name: 42 },
      { name: "other", pm_id: 99, pm2_env: { env: { PORT: "9999" } } },
      { name: "maw-sidecar", pm_id: 3, pm2_env: {} },
      { name: "maw", pm2_env: { PORT: "4567" } },
    ]);
    fetchMode = "aligned";
    const aligned = await doctorModule.cmdDoctor(["version"]);
    expect(aligned.ok).toBe(true);
    expect(aligned.checks.map((c) => c.message)).toEqual([
      "aligned (1.2.3-test) :3456",
      "aligned (1.2.3-test) :4567",
    ]);

    fetchMode = "non-ok";
    const unreachable = await doctorModule.cmdDoctor(["version"]);
    expect(unreachable.ok).toBe(false);
    expect(unreachable.checks[0]?.message).toBe("unreachable at :3456 — source 1.2.3-test");

    fetchMode = "bad-json";
    expect((await doctorModule.cmdDoctor(["version"])).checks[0]?.message).toBe("unreachable at :3456 — source 1.2.3-test");
  });

  test("peers/all checks cover unreadable cache, config fallback, singular/plural success, and full-suite rendering", async () => {
    loadPeersError = new Error("cache boom");
    let result = await doctorModule.cmdDoctor(["peers"]);
    expect(result.ok).toBe(true);
    expect(result.checks[0]).toEqual({
      name: "peers:duplicates",
      ok: true,
      message: "peer cache unreadable (cache boom) — skipping dedup check",
    });

    loadPeersError = null;
    configError = new Error("config boom");
    peersStore = {
      solo: {
        url: "http://solo",
        node: "remote",
        addedAt: "x",
        lastSeen: "y",
        identity: { oracle: "remote", node: "remote" },
      },
    };
    result = await doctorModule.cmdDoctor(["peers"]);
    expect(result.checks[0]?.message).toBe("no <oracle>:<node> collisions across 1 peer");

    configError = null;
    configValue = {};
    peersStore.second = {
      url: "http://second",
      node: "second",
      addedAt: "x",
      lastSeen: "y",
      identity: { oracle: "remote", node: "second" },
    };
    result = await doctorModule.cmdDoctor(["peers"]);
    expect(result.checks[0]?.message).toBe("no <oracle>:<node> collisions across 2 peers");

    const all = await doctorModule.cmdDoctor(["all"]);
    expect(all.checks.map((c) => c.name)).toEqual([
      "install",
      "xdg:paths",
      "version:pm2",
      "peers:duplicates",
      "peers:stale",
      "manifest:cross-source",
      "maw-js:branch",
      "worktrees:stillborn",
    ]);
    expect(logs.join("\n")).toContain("maw doctor");
  });

  test("fix-stale, duplicate failures, manifest warnings, and smoke command errors stay isolated", async () => {
    const fixStale = await doctorModule.cmdDoctor(["--fix-stale"]);
    expect(fixStale).toEqual({ ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: "noop" }] });

    peersStore = {
      twin: {
        url: "http://twin",
        node: "local-node",
        addedAt: "x",
        lastSeen: "y",
        identity: { oracle: "local-oracle", node: "local-node" },
      },
    };
    const duplicate = await doctorModule.cmdDoctor(["peers"]);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.checks[0]?.message).toContain('duplicate <oracle>:<node> claim "local-oracle:local-node"');

    manifestValue = [
      { name: "ghost", node: "n", sources: ["agent"] },
      { name: "orphan", sources: ["oracles-json"] },
    ];
    const manifest = await doctorModule.cmdDoctor(["manifest"]);
    expect(manifest.ok).toBe(true);
    expect(invalidateCalls).toBe(1);
    expect(manifest.checks[0]?.message).toContain("1 cross-source gap");
    expect(logs.join("\n")).toContain("[oracles-json-without-runtime]");

    manifestError = new Error("manifest boom");
    expect((await doctorModule.cmdDoctor(["manifest"])).checks[0]?.message)
      .toBe("manifest unreadable (manifest boom) — skipping cross-source check");

    let spawnCount = 0;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[]) => {
      spawnCount += 1;
      const label = cmd.slice(1).join(" ");
      if (label === "ls") return fakeProc(0, "one\ntwo\n");
      if (label === "oracle ls --json") return fakeProc(1, "", "oracle boom\ntrace");
      if (label === "oracle search maw") throw new Error("spawn boom");
      return fakeProc(0, "ok\n");
    }) as typeof Bun.spawn;

    const smoke = await doctorModule.cmdDoctor(["smoke"]);
    expect(smoke.ok).toBe(false);
    expect(smoke.checks.map((c) => c.name)).toEqual([
      "smoke:ls",
      "smoke:oracle ls",
      "smoke:oracle search",
      "smoke:--version",
      "smoke:fleet ls",
      "smoke:plugins",
      "smoke:symlinks",
    ]);
    expect(smoke.checks[1]?.message).toBe("oracle boom");
    expect(smoke.checks[2]?.message).toBe("spawn boom");
    expect(spawnCount).toBe(5);
  });
});

type ProbeShape = {
  node: string | null;
  error?: { code: string; message: string; at: string };
  nickname?: string | null;
  identity?: Record<string, unknown>;
  pubkey?: string;
};

describe("pair internal peers impl extra branch coverage", () => {
  const storePath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/store.ts");
  const probePath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/probe.ts");
  const tofuPath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/tofu.ts");

  let implModule: typeof import("../../src/vendor/mpr-plugins/pair/internal/peers-impl");
  let peers: Record<string, any> = {};
  let probeResult: ProbeShape = { node: "probe-node" };
  let probeCalls: string[] = [];
  let tofuCalls: Array<{ alias: string; kind: string }> = [];
  let forgetCalls: string[] = [];
  let forgetOutcome: "cleared" | "no-pubkey" | "not-found" = "cleared";
  let evaluateDecision: {
    kind: "match" | "mismatch" | "tofu-bootstrap" | "legacy-first-contact" | "legacy-after-pinned";
    cached?: string;
    observed?: string;
  } = { kind: "match" };

  beforeAll(async () => {
    mock.module(storePath, () => ({
      loadPeers: () => ({ peers }),
      mutatePeers: (mutate: (data: { peers: Record<string, any> }) => void) => {
        const data = { peers: { ...peers } };
        mutate(data);
        peers = data.peers;
      },
    }));

    mock.module(probePath, () => ({
      probePeer: async (url: string) => {
        probeCalls.push(url);
        return probeResult;
      },
    }));

    mock.module(tofuPath, () => ({
      evaluatePeerIdentity: (_alias: string, existing: any, observed: string | undefined) => ({
        ...evaluateDecision,
        cached: evaluateDecision.cached ?? existing?.pubkey,
        observed: evaluateDecision.observed ?? observed,
      }),
      applyTofuDecision: (decision: { kind: string }) => {
        tofuCalls.push({ alias: "pair", kind: decision.kind });
      },
      forgetPeerPubkey: (alias: string) => {
        forgetCalls.push(alias);
        return forgetOutcome;
      },
      PeerPubkeyMismatchError: class extends Error {
        constructor(alias: string, cached: string, observed: string) {
          super(`peer pubkey changed for ${alias}: ${cached} → ${observed}`);
        }
      },
    }));

    implModule = await import("../../src/vendor/mpr-plugins/pair/internal/peers-impl.ts?vendor-doctor-pair-extra-pair");
  });

  beforeEach(() => {
    peers = {};
    probeResult = { node: "probe-node" };
    probeCalls = [];
    tofuCalls = [];
    forgetCalls = [];
    forgetOutcome = "cleared";
    evaluateDecision = { kind: "match" };
  });

  test("validation helpers and resolveNode cover valid, malformed, unsupported, and null probe paths", async () => {
    expect(implModule.validateAlias("good_alias-1")).toBeNull();
    expect(implModule.validateUrl("not a url")).toBe('invalid URL "not a url"');
    expect(implModule.validateUrl("ftp://peer.example")).toBe('invalid URL "ftp://peer.example" (must be http:// or https://)');
    expect(implModule.validateUrl("https://peer.example")).toBeNull();

    probeResult = { node: null, error: { code: "DNS", message: "nope", at: "2026-05-18T00:00:00.000Z" } };
    expect(await implModule.resolveNode("https://peer.example")).toBeNull();
    expect(probeCalls).toEqual(["https://peer.example"]);
  });

  test("cmdAdd rejects invalid input before probing", async () => {
    await expect(implModule.cmdAdd({ alias: "Bad", url: "https://peer.example" })).rejects.toThrow("invalid alias");
    await expect(implModule.cmdAdd({ alias: "good", url: "ssh://peer.example" })).rejects.toThrow("invalid URL");
    expect(probeCalls).toEqual([]);
  });

  test("cmdAdd handles probe-error bootstrap, cached identity fallback, and mismatch refusal", async () => {
    probeResult = {
      node: null,
      pubkey: "observed-key",
      nickname: "remote-nick",
      error: { code: "TIMEOUT", message: "slow", at: "2026-05-18T00:00:00.000Z" },
    };
    evaluateDecision = { kind: "tofu-bootstrap", observed: "observed-key" };

    const added = await implModule.cmdAdd({ alias: "slow", url: "https://slow.example" });
    expect(added).toMatchObject({
      alias: "slow",
      overwrote: false,
      probeError: { code: "TIMEOUT" },
      peer: {
        url: "https://slow.example",
        node: null,
        lastSeen: null,
        lastError: { message: "slow" },
        nickname: "remote-nick",
        pubkey: "observed-key",
      },
    });
    expect(added.peer.pubkeyFirstSeen).toBeString();
    expect(tofuCalls).toEqual([{ alias: "pair", kind: "tofu-bootstrap" }]);

    peers.cached = {
      url: "https://cached-old.example",
      node: "old-node",
      addedAt: "old",
      lastSeen: "old-seen",
      identity: { oracle: "cached-oracle", node: "cached-node" },
    };
    probeResult = { node: "fresh-node" };
    evaluateDecision = { kind: "legacy-first-contact" };
    const fallback = await implModule.cmdAdd({ alias: "cached", url: "https://cached-new.example" });
    expect(fallback.overwrote).toBe(true);
    expect(fallback.peer).toMatchObject({
      node: "fresh-node",
      identity: { oracle: "cached-oracle", node: "cached-node" },
    });

    peers.rotated = {
      url: "https://rotated.example",
      node: "old-node",
      addedAt: "old",
      lastSeen: "old-seen",
      pubkey: "cached-key",
    };
    probeResult = {
      node: "rotated-node",
      pubkey: "new-key",
      error: { code: "UNKNOWN", message: "changed", at: "2026-05-18T00:00:00.000Z" },
    };
    evaluateDecision = { kind: "mismatch", cached: "cached-key", observed: "new-key" };
    const refused = await implModule.cmdAdd({ alias: "rotated", url: "https://rotated.example" });
    expect(refused.overwrote).toBe(true);
    expect(refused.peer).toBe(peers.rotated);
    expect(refused.probeError?.message).toBe("changed");
    expect(refused.pubkeyMismatch?.message).toContain("cached-key → new-key");
  });

  test("cmdProbe success keeps existing node when probe has none and forget delegates valid aliases", async () => {
    peers.probed = {
      url: "https://probed.example",
      node: "cached-node",
      addedAt: "old",
      lastSeen: "old-seen",
      lastError: { code: "OLD", message: "old", at: "old" },
    };
    probeResult = {
      node: null,
      nickname: "new-nick",
      identity: { oracle: "fresh-oracle", node: "fresh-node" },
    };

    const probed = await implModule.cmdProbe("probed");
    expect(probed).toMatchObject({
      alias: "probed",
      url: "https://probed.example",
      node: "cached-node",
      ok: true,
    });
    expect(peers.probed.lastError).toBeUndefined();
    expect(peers.probed.nickname).toBe("new-nick");
    expect(peers.probed.identity).toEqual({ oracle: "fresh-oracle", node: "fresh-node" });

    forgetOutcome = "not-found";
    expect(await implModule.cmdForget("probed")).toBe("not-found");
    expect(forgetCalls).toEqual(["probed"]);
  });

  test("cmdProbe mismatch/error paths and list/info/remove/format branches are covered", async () => {
    peers.err = {
      url: "https://err.example",
      node: "old-node",
      nickname: "keep-nick",
      addedAt: "old",
      lastSeen: "old-seen",
    };
    probeResult = {
      node: null,
      error: { code: "REFUSED", message: "closed", at: "2026-05-18T00:00:00.000Z" },
    };
    const failed = await implModule.cmdProbe("err");
    expect(failed).toMatchObject({ alias: "err", node: "old-node", ok: false, error: { message: "closed" } });
    expect(peers.err).toMatchObject({ lastSeen: "old-seen", lastError: { message: "closed" }, nickname: "keep-nick" });

    peers.rotprobe = {
      url: "https://rotprobe.example",
      node: "old-node",
      pubkey: "cached-key",
      addedAt: "old",
      lastSeen: "old-seen",
    };
    probeResult = { node: null, pubkey: "new-key" };
    evaluateDecision = { kind: "mismatch", cached: "cached-key", observed: "new-key" };
    const mismatch = await implModule.cmdProbe("rotprobe");
    expect(mismatch).toMatchObject({ alias: "rotprobe", node: "old-node", ok: false });
    expect(mismatch.pubkeyMismatch?.message).toContain("cached-key → new-key");

    peers = {
      b: { url: "https://b.example", node: "node-b", nickname: "bee", addedAt: "x", lastSeen: "2026-01-01" },
      a: { url: "https://a.example", node: null, addedAt: "x", lastSeen: null },
    };
    const rows = implModule.cmdList();
    expect(rows.map((row) => row.alias)).toEqual(["a", "b"]);
    expect(implModule.cmdInfo("b")).toEqual({ alias: "b", ...peers.b });
    expect(implModule.cmdInfo("missing")).toBeNull();
    expect(implModule.cmdRemove("a")).toBe(true);
    expect(implModule.cmdRemove("missing")).toBe(false);
    expect(implModule.formatList([])).toBe("no peers");
    const formatted = implModule.formatList(rows);
    expect(formatted).toContain("alias");
    expect(formatted).toContain("nickname");
    expect(formatted).toContain("a      https://a.example  -       -         -");
    expect(formatted).toContain("b      https://b.example  node-b  bee       2026-01-01");
  });
});
