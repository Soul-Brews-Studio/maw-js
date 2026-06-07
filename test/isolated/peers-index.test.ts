import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

type ProbeCode = "UNKNOWN" | "DNS" | "REFUSED" | "TIMEOUT" | "HTTP";

let addResult: any;
let probeResult: any;
let probeAllResult: any;
let listResult = "formatted-list";
let infoResult: any;
let removeResult = false;
let forgetResult: "cleared" | "no-pubkey" | "not-found" = "cleared";
let storePeers: Record<string, { url: string }> = {};
let discoveryResponse: any;
let acceptedResponse: any;
let implThrows: Error | null = null;

let addCalls: any[] = [];
let probeCalls: string[] = [];
let probeAllCalls: number[] = [];
let infoCalls: string[] = [];
let removeCalls: string[] = [];
let forgetCalls: string[] = [];
let acceptCalls: any[] = [];
let discoveryCalls: any[] = [];

const implPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/peers/impl.ts");
const probePath = join(import.meta.dir, "../../src/vendor/mpr-plugins/peers/probe.ts");
const probeAllPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/peers/probe-all.ts");
const storePath = join(import.meta.dir, "../../src/vendor/mpr-plugins/peers/store.ts");
const discoveredPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/peers/discovered.ts");

mock.module(implPath, () => ({
  cmdAdd: async (args: any) => {
    addCalls.push(args);
    if (implThrows) throw implThrows;
    return addResult;
  },
  cmdProbe: async (alias: string) => {
    probeCalls.push(alias);
    if (implThrows) throw implThrows;
    return probeResult;
  },
  cmdList: () => {
    if (implThrows) throw implThrows;
    return ["peer-a"];
  },
  formatList: () => {
    if (implThrows) throw implThrows;
    return listResult;
  },
  cmdInfo: (alias: string) => {
    infoCalls.push(alias);
    if (implThrows) throw implThrows;
    return infoResult;
  },
  cmdRemove: (alias: string) => {
    removeCalls.push(alias);
    if (implThrows) throw implThrows;
    return removeResult;
  },
  cmdForget: async (alias: string) => {
    forgetCalls.push(alias);
    if (implThrows) throw implThrows;
    return forgetResult;
  },
}));

mock.module(probePath, () => ({
  formatProbeError: (error: { code: ProbeCode }, url: string, alias: string) =>
    `probe:${alias}:${url}:${error.code}`,
  PROBE_EXIT_CODES: { UNKNOWN: 2, DNS: 3, REFUSED: 4, TIMEOUT: 5, HTTP: 6 },
}));

mock.module(probeAllPath, () => ({
  cmdProbeAll: async (timeoutMs: number) => {
    probeAllCalls.push(timeoutMs);
    return probeAllResult;
  },
  formatProbeAll: (result: any) => `probe-all:${result.failCount}/${result.rows.length}`,
}));

mock.module(storePath, () => ({
  loadPeers: () => ({ peers: storePeers }),
}));

mock.module(discoveredPath, () => ({
  fetchDiscoveries: async (opts: any) => {
    discoveryCalls.push(opts);
    return discoveryResponse;
  },
  formatDiscoveries: (resp: any) => `discoveries:${resp.total ?? 0}`,
  acceptPeer: async (opts: any) => {
    acceptCalls.push(opts);
    return acceptedResponse;
  },
}));

const peersPlugin = await import("../../src/vendor/mpr-plugins/peers/index");
const handler = peersPlugin.default;

beforeEach(() => {
  addResult = { overwrote: false, peer: {}, probeError: null, pubkeyMismatch: null };
  probeResult = { ok: true, node: "peer-node", pubkeyMismatch: null };
  probeAllResult = { failCount: 0, rows: [], worstExitCode: 0 };
  listResult = "formatted-list";
  infoResult = { alias: "mba", url: "http://mba:3456" };
  removeResult = false;
  forgetResult = "cleared";
  storePeers = {};
  discoveryResponse = { ok: true, total: 1, peers: [] };
  acceptedResponse = { ok: true, alias: "mba", node: "m5", url: "http://mba:3456" };
  implThrows = null;

  addCalls = [];
  probeCalls = [];
  probeAllCalls = [];
  infoCalls = [];
  removeCalls = [];
  forgetCalls = [];
  acceptCalls = [];
  discoveryCalls = [];
});

async function invoke(args: string[], writer?: (...args: unknown[]) => void) {
  return handler({ source: "cli", args, writer } as any);
}

describe("vendor peers plugin dispatcher", () => {
  test("prints help on missing subcommand and uses ctx.writer when provided", async () => {
    const writes: string[] = [];
    const result = await invoke([], (...args: unknown[]) => writes.push(args.map(String).join(" ")));

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw peers");
    expect(writes.join("\n")).toContain("probe-all");
  });

  test("add validates args, handles overwrite, and returns probe exit code on handshake failure", async () => {
    expect(await invoke(["add"])).toEqual({
      ok: false,
      error: "usage: maw peers add <alias> <url> [--node <name>] [--allow-unreachable]",
    });

    addResult = {
      overwrote: true,
      peer: { node: "white" },
      probeError: { code: "DNS" as ProbeCode },
      pubkeyMismatch: null,
    };

    const result = await invoke(["add", "mba", "http://mba:3456", "--node", "white"]);

    expect(addCalls).toEqual([{ alias: "mba", url: "http://mba:3456", node: "white" }]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("warning: alias \"mba\" already existed");
    expect(result.output).toContain("added mba → http://mba:3456 (white)");
    expect(result.output).toContain("probe:mba:http://mba:3456:DNS");
  });

  test("add supports allow-unreachable and TOFU mismatch refusal", async () => {
    addResult = {
      overwrote: false,
      peer: {},
      probeError: { code: "REFUSED" as ProbeCode },
      pubkeyMismatch: null,
    };
    const allowed = await invoke(["add", "mba", "http://mba:3456", "--allow-unreachable"]);
    expect(allowed.ok).toBe(true);
    expect(allowed.output).toContain("probe:mba:http://mba:3456:REFUSED");

    addResult = {
      overwrote: false,
      peer: {},
      probeError: null,
      pubkeyMismatch: { message: "pubkey mismatch" },
    };
    const mismatch = await invoke(["add", "mba", "http://mba:3456"]);
    expect(mismatch).toMatchObject({ ok: false, error: "pubkey mismatch", exitCode: 7 });
    expect(mismatch.output).toContain("pubkey mismatch");
  });

  test("probe handles missing alias, missing store entry, success, mismatch, and failure formatting", async () => {
    expect(await invoke(["probe"])).toEqual({
      ok: false,
      error: "usage: maw peers probe <alias>",
    });

    expect(await invoke(["probe", "mba"])).toEqual({
      ok: false,
      error: 'peer "mba" not found',
    });

    storePeers = { mba: { url: "http://mba:3456" } };
    probeResult = { ok: true, node: "white", pubkeyMismatch: null };
    const success = await invoke(["probe", "mba"]);
    expect(success.ok).toBe(true);
    expect(success.output).toContain("probing mba → http://mba:3456 ...");
    expect(success.output).toContain("reached mba (white)");

    probeResult = { ok: false, pubkeyMismatch: { message: "probe mismatch" } };
    const mismatch = await invoke(["probe", "mba"]);
    expect(mismatch).toMatchObject({ ok: false, error: "probe mismatch", exitCode: 7 });

    probeResult = { ok: false, error: { code: "TIMEOUT" as ProbeCode }, pubkeyMismatch: null };
    const failure = await invoke(["probe", "mba"]);
    expect(failure).toMatchObject({ ok: false, error: "probe failed: TIMEOUT" });
    expect(failure.output).toContain("probe:mba:http://mba:3456:TIMEOUT");
  });

  test("probe-all validates timeout and surfaces worst exit code unless allow-unreachable is set", async () => {
    expect(await invoke(["probe-all", "--timeout", "wat"])).toEqual({
      ok: false,
      error: "usage: maw peers probe-all [--timeout <ms>]  (got --timeout wat)",
    });

    probeAllResult = { failCount: 2, rows: [{}, {}], worstExitCode: 6 };
    const failed = await invoke(["probe-all", "--timeout", "2500"]);
    expect(probeAllCalls).toEqual([2500]);
    expect(failed).toMatchObject({
      ok: false,
      error: "probe-all: 2/2 peer(s) failed — pass --allow-unreachable to exit 0",
      exitCode: 6,
    });
    expect(failed.output).toContain("probe-all:2/2");

    const allowed = await invoke(["probe-all", "--allow-unreachable"]);
    expect(allowed.ok).toBe(true);
  });

  test("list handles discovered validation, discovered errors, discovered json, and plain ls", async () => {
    const invalid = await invoke(["list", "--discovered", "--limit", "nope"]);
    expect(invalid).toEqual({
      ok: false,
      error: "usage: maw peers list --discovered [--all] [--json] [--limit N] (got --limit nope)",
    });

    discoveryResponse = { ok: false, error: "daemon down", hint: "restart maw serve" };
    const failed = await invoke(["list", "--discovered"]);
    expect(failed).toMatchObject({ ok: false, error: "daemon down" });
    expect(failed.output).toContain("daemon down — restart maw serve");

    discoveryResponse = { ok: true, total: 2, peers: [{ node: "a" }] };
    const json = await invoke(["list", "--discovered", "--json", "--all", "--limit", "5"]);
    expect(discoveryCalls.at(-1)).toEqual({ all: true, limit: 5 });
    expect(json.ok).toBe(true);
    expect(json.output).toContain('"total": 2');

    const normal = await invoke(["ls"]);
    expect(normal).toEqual({ ok: true, output: "formatted-list" });
  });

  test("accept handles missing id, candidate errors, single success, all error, and all summaries", async () => {
    expect(await invoke(["accept"])).toEqual({
      ok: false,
      error: "usage: maw peers accept <node|zid-prefix> [--alias X] | --all",
    });

    acceptedResponse = {
      ok: false,
      error: "ambiguous",
      hint: "be more specific",
      candidates: [{ zid: "1234567890abcdef", node: "alpha", host: "alpha.local" }],
    };
    const ambiguous = await invoke(["accept", "a"]);
    expect(ambiguous).toMatchObject({ ok: false, error: "ambiguous" });
    expect(ambiguous.output).toContain("candidates:");
    expect(ambiguous.output).toContain("1234567890ab… alpha (alpha.local)");

    acceptedResponse = { ok: true, alias: "friend", node: "white", url: "http://white:3456" };
    const single = await invoke(["accept", "white", "--alias", "friend"]);
    expect(acceptCalls.at(-1)).toEqual({ id: "white", alias: "friend" });
    expect(single.ok).toBe(true);
    expect(single.output).toContain("accepted friend (white) → http://white:3456");

    acceptedResponse = { ok: false, error: "daemon missing", hint: "start serve" };
    const allFailed = await invoke(["accept", "--all"]);
    expect(allFailed).toMatchObject({ ok: false, error: "daemon missing" });

    acceptedResponse = {
      ok: true,
      accepted: [{ alias: "a1" }],
      skipped: [{ id: "z2", error: "dup", hint: "remove stale peer" }],
    };
    const all = await invoke(["accept", "--all"]);
    expect(acceptCalls.at(-1)).toEqual({ all: true });
    expect(all.ok).toBe(true);
    expect(all.output).toContain("accepted a1");
    expect(all.output).toContain("skipped z2: dup — remove stale peer");
  });

  test("info, remove, and forget cover lookup and outcome branches", async () => {
    expect(await invoke(["info"])).toEqual({ ok: false, error: "usage: maw peers info <alias>" });

    infoResult = null;
    expect(await invoke(["info", "ghost"])).toEqual({ ok: false, error: 'peer "ghost" not found' });

    infoResult = { alias: "mba", url: "http://mba:3456", lastError: "timeout" };
    const info = await invoke(["info", "mba"]);
    expect(info.ok).toBe(true);
    expect(info.output).toContain('"alias": "mba"');

    expect(await invoke(["remove"])).toEqual({ ok: false, error: "usage: maw peers remove <alias>" });
    removeResult = true;
    expect(await invoke(["rm", "mba"])).toEqual({ ok: true, output: "removed mba" });
    removeResult = false;
    expect(await invoke(["remove", "ghost"])).toEqual({ ok: true, output: "no-op: ghost not present" });

    expect(await invoke(["forget"])).toEqual({ ok: false, error: "usage: maw peers forget <alias>" });
    forgetResult = "cleared";
    expect(await invoke(["forget", "mba"])).toEqual({
      ok: true,
      output: "forgot pubkey for mba — next contact will re-TOFU",
    });
    forgetResult = "no-pubkey";
    expect(await invoke(["forget", "legacy"])).toEqual({
      ok: true,
      output: "no-op: legacy has no cached pubkey (legacy peer)",
    });
    forgetResult = "not-found";
    expect(await invoke(["forget", "ghost"])).toEqual({
      ok: false,
      error: 'peer "ghost" not found',
      output: "",
    });
  });

  test("unknown subcommand prints help and thrown impl errors fall back to exception text", async () => {
    const unknown = await invoke(["wat"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('unknown subcommand "wat"');
    expect(unknown.output).toContain("usage: maw peers");

    implThrows = new Error("boom");
    const thrown = await invoke(["list"]);
    expect(thrown).toEqual({ ok: false, error: "boom", output: undefined });
  });
});
