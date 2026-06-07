import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fleetDir = mkdtempSync(join(tmpdir(), "maw-vendor-about-bud-send-extra-fleet-"));
const sleepImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/sleep/impl.ts");
const dreamImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/dream/impl.ts");

type Session = { name: string; windows?: Array<{ name: string; index?: number }> };
type CurlResult = { ok: boolean; status?: number; data?: any };

let sessions: Session[] = [];
let listSessionsError: Error | null = null;
let ghqResults = new Map<string, string | null>();
let ghqCalls: string[] = [];
let hostExecCalls: string[] = [];
let hostExecQueue: Array<string | Error> = [];
let configState: Record<string, unknown> = { node: "local" };
let resolvedTarget: any = null;
let resolveTargetCalls: Array<{ query: string; config: Record<string, unknown>; sessions: Session[] }> = [];
let curlCalls: Array<{ url: string; init: any }> = [];
let curlQueue: CurlResult[] = [];
let paneResult = "session:window.1";
let paneError: Error | null = null;
let paneCalls: string[] = [];
let literalCalls: Array<{ target: string; text: string }> = [];
let keyCalls: Array<{ target: string; key: string }> = [];
let textCalls: Array<{ target: string; text: string }> = [];
let sleepCalls: Array<{ oracle: string; window?: string }> = [];
let sleepLogs: string[] = [];
let sleepError: Error | null = null;
let dreamCalls: any[] = [];
let dreamLogs: string[] = [];
let dreamErrorLogs: string[] = [];
let dreamError: Error | null = null;

const originalConsole = {
  log: console.log,
  error: console.error,
};
const originalDateNow = Date.now;

function loadTestFleetEntries() {
  return readdirSync(fleetDir)
    .filter(file => file.endsWith(".json") && !file.endsWith(".disabled"))
    .sort()
    .map(file => {
      const match = file.match(/^(\d+)-(.+)\.json$/);
      return {
        file,
        path: join(fleetDir, file),
        num: match ? Number.parseInt(match[1], 10) : 0,
        groupName: match ? match[2] : file.replace(/\.json$/, ""),
        session: JSON.parse(readFileSync(join(fleetDir, file), "utf-8") || "{}"),
      };
    });
}

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleetEntries: loadTestFleetEntries,
}));

mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  listSessions: async () => {
    if (listSessionsError) throw listSessionsError;
    return sessions;
  },
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    const next = hostExecQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  resolveTarget: (query: string, config: Record<string, unknown>, listedSessions: Session[]) => {
    resolveTargetCalls.push({ query, config, sessions: listedSessions });
    return resolvedTarget;
  },
  Tmux: class {
    async sendKeysLiteral(target: string, text: string) {
      literalCalls.push({ target, text });
    }
    async sendKeys(target: string, key: string) {
      keyCalls.push({ target, key });
    }
    async sendText(target: string, text: string) {
      textCalls.push({ target, text });
    }
  },
  curlFetch: async (url: string, init: any) => {
    curlCalls.push({ url, init });
    return curlQueue.shift() ?? { ok: true, data: { ok: true, target: "peer-pane" } };
  },
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async (pattern: string) => {
    ghqCalls.push(pattern);
    return ghqResults.get(pattern) ?? null;
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => configState,
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  resolveOraclePane: async (target: string) => {
    paneCalls.push(target);
    if (paneError) throw paneError;
    return paneResult;
  },
}));

mock.module(sleepImplPath, () => ({
  cmdSleepOne: async (oracle: string, window?: string) => {
    sleepCalls.push({ oracle, window });
    for (const line of sleepLogs) console.log(line);
    if (sleepError) throw sleepError;
  },
}));

mock.module(dreamImplPath, () => ({
  cmdDream: async (flags: any) => {
    dreamCalls.push(flags);
    for (const line of dreamLogs) console.log(line);
    for (const line of dreamErrorLogs) console.error(line);
    if (dreamError) throw dreamError;
  },
}));

const aboutHelpers = await import("../../src/vendor/mpr-plugins/about/internal/impl-helpers.ts?vendor-extra-coverage");
const budGit = await import("../../src/vendor/mpr-plugins/bud/from-repo-git.ts?vendor-extra-coverage");
const runImpl = await import("../../src/vendor/mpr-plugins/run/impl.ts?vendor-extra-coverage");
const sleepHandler = (await import("../../src/vendor/mpr-plugins/sleep/index.ts?vendor-extra-coverage")).default;
const dreamHandler = (await import("../../src/vendor/mpr-plugins/dream/index.ts?vendor-extra-coverage")).default;
const sendTextImpl = await import("../../src/vendor/mpr-plugins/send-text/impl.ts?vendor-extra-coverage");
const sendImpl = await import("../../src/vendor/mpr-plugins/send/impl.ts?vendor-extra-coverage");

function resetFleetDir() {
  rmSync(fleetDir, { recursive: true, force: true });
  mkdirSync(fleetDir, { recursive: true });
}

function writeFleet(file: string, windows: Array<{ name: string }>) {
  writeFileSync(join(fleetDir, file), JSON.stringify({ windows }, null, 2), "utf-8");
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function captureConsole<T>(fn: () => T | Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), output: lines.join("\n") };
  } finally {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
  }
}

function ctx(source: string, args: unknown, writer?: (...args: unknown[]) => void) {
  return { source, args, writer } as any;
}

function resetSendState() {
  configState = { node: "local-node", agents: {} };
  sessions = [{ name: "01-local", windows: [{ name: "neo-oracle" }] }];
  resolvedTarget = null;
  resolveTargetCalls = [];
  curlCalls = [];
  curlQueue = [];
  paneResult = "01-local:neo-oracle.2";
  paneError = null;
  paneCalls = [];
  literalCalls = [];
  keyCalls = [];
  textCalls = [];
}

beforeEach(() => {
  resetFleetDir();
  sessions = [];
  listSessionsError = null;
  ghqResults = new Map();
  ghqCalls = [];
  hostExecCalls = [];
  hostExecQueue = [];
  resetSendState();
  sleepCalls = [];
  sleepLogs = [];
  sleepError = null;
  dreamCalls = [];
  dreamLogs = [];
  dreamErrorLogs = [];
  dreamError = null;
});

afterEach(() => {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  Date.now = originalDateNow;
});

afterAll(() => {
  rmSync(fleetDir, { recursive: true, force: true });
});

describe("about impl helpers", () => {
  test("resolveOracleSafe tries -oracle first, falls back to direct repo, and returns an empty miss", async () => {
    ghqResults.set("/parent-oracle$", "/repos/parent-oracle");
    await expect(aboutHelpers.resolveOracleSafe("parent")).resolves.toEqual({
      repoPath: "/repos/parent-oracle",
      repoName: "parent-oracle",
      parentDir: "/repos",
    });
    expect(ghqCalls).toEqual(["/parent-oracle$"]);

    ghqCalls = [];
    ghqResults = new Map([["/homekeeper$", "/repos/homekeeper"]]);
    await expect(aboutHelpers.resolveOracleSafe("homekeeper")).resolves.toEqual({
      repoPath: "/repos/homekeeper",
      repoName: "homekeeper",
      parentDir: "/repos",
    });
    expect(ghqCalls).toEqual(["/homekeeper-oracle$", "/homekeeper$"]);

    ghqCalls = [];
    ghqResults = new Map();
    await expect(aboutHelpers.resolveOracleSafe("ghost")).resolves.toEqual({ parentDir: "", repoName: "", repoPath: "" });
    expect(ghqCalls).toEqual(["/ghost-oracle$", "/ghost$"]);
  });

  test("discoverOracles merges fleet and tmux names, sorts, and tolerates missing sources", async () => {
    writeFleet("zeta.json", [{ name: "zeta-oracle" }, { name: "plain" }]);
    writeFleet("alpha.json", [{ name: "alpha-oracle" }]);
    writeFileSync(join(fleetDir, "ignored.disabled"), JSON.stringify({ windows: [{ name: "ignored-oracle" }] }), "utf-8");
    sessions = [
      { name: "01-alpha", windows: [{ name: "alpha-oracle" }, { name: "scratch" }] },
      { name: "02-beta", windows: [{ name: "beta-oracle" }] },
    ];

    await expect(aboutHelpers.discoverOracles()).resolves.toEqual(["alpha", "beta", "zeta"]);

    rmSync(fleetDir, { recursive: true, force: true });
    listSessionsError = new Error("tmux unavailable");
    await expect(aboutHelpers.discoverOracles()).resolves.toEqual([]);
  });

  test("lineageOf records config, psi, awake, and federation provenance; timeSince formats all buckets", () => {
    expect(aboutHelpers.lineageOf(
      { name: "neo", has_fleet_config: true, has_psi: false, federation_node: "entry-node" } as any,
      true,
      { neo: "agent-node" },
    )).toEqual({
      hasFleetConfig: true,
      hasPsi: false,
      isAwake: true,
      inAgents: true,
      federationNode: "agent-node",
    });
    expect(aboutHelpers.lineageOf(
      { name: "trinity", has_fleet_config: false, has_psi: true, federation_node: "entry-node" } as any,
      false,
      {},
    )).toEqual({
      hasFleetConfig: false,
      hasPsi: true,
      isAwake: false,
      inAgents: false,
      federationNode: "entry-node",
    });

    Date.now = () => new Date("2026-05-18T00:00:00.000Z").getTime();
    expect(aboutHelpers.timeSince("2026-05-17T23:59:31.000Z")).toBe("29s");
    expect(aboutHelpers.timeSince("2026-05-17T23:30:00.000Z")).toBe("30m");
    expect(aboutHelpers.timeSince("2026-05-17T02:00:00.000Z")).toBe("22h");
    expect(aboutHelpers.timeSince("2026-05-15T00:00:00.000Z")).toBe("3d");
  });
});

describe("bud from-repo git helpers", () => {
  test("cloneShallow quotes unsafe URLs, removes failed tmpdirs, and cleanupClone is idempotent", async () => {
    hostExecQueue = [new Error("clone failed")];
    await expect(budGit.cloneShallow("https://example.test/repo's.git")).rejects.toThrow("clone failed");
    expect(hostExecCalls[0]).toContain("git clone --depth 1 'https://example.test/repo'\\''s.git'");
    const failedDir = hostExecCalls[0]!.match(/ '(\/[^']*maw-bud-from-repo-[^']*)'$/)?.[1];
    expect(failedDir).toBeTruthy();
    expect(existsSync(failedDir!)).toBe(false);

    hostExecCalls = [];
    hostExecQueue = [""];
    const cloned = await budGit.cloneShallow("https://example.test/ok.git");
    expect(existsSync(cloned)).toBe(true);
    expect(hostExecCalls[0]).toContain("git clone --depth 1 'https://example.test/ok.git'");
    budGit.cleanupClone(cloned);
    budGit.cleanupClone(cloned);
    expect(existsSync(cloned)).toBe(false);
  });

  test("branchCommitPushPR runs branch/add/commit/push/gh in order and extracts or falls back to PR output", async () => {
    const logs: string[] = [];
    hostExecQueue = ["", "", "", "", "created\nhttps://github.com/Soul-Brews-Studio/child/pull/42\n"];

    await expect(budGit.branchCommitPushPR("/tmp/work dir/it's", "seed", (line) => logs.push(stripAnsi(line)))).resolves.toBe(
      "https://github.com/Soul-Brews-Studio/child/pull/42",
    );

    expect(budGit.scaffoldBranchName("seed")).toBe("oracle/scaffold-seed");
    expect(hostExecCalls).toHaveLength(5);
    expect(hostExecCalls[0]).toContain("git checkout -b 'oracle/scaffold-seed'");
    expect(hostExecCalls[1]).toContain("git add -A");
    expect(hostExecCalls[2]).toContain("git commit -m 'oracle: scaffold from maw bud --from-repo (stem=seed)'");
    expect(hostExecCalls[3]).toContain("git push -u origin 'oracle/scaffold-seed'");
    expect(hostExecCalls[4]).toContain("gh pr create --fill --head 'oracle/scaffold-seed'");
    expect(logs.join("\n")).toContain("PR opened: https://github.com/Soul-Brews-Studio/child/pull/42");

    hostExecCalls = [];
    hostExecQueue = ["", "", "", "", "pull request created without url\n"];
    await expect(budGit.branchCommitPushPR("/tmp/repo", "fallback", () => undefined)).resolves.toBe(
      "pull request created without url",
    );
  });
});

describe("sleep plugin entrypoint", () => {
  test("validates CLI/API args, handles all-done placeholder, and routes success through writer", async () => {
    await expect(sleepHandler(ctx("cli", []))).resolves.toEqual({
      ok: false,
      error: "usage: maw sleep <oracle> [window]  (see: maw kill for immediate removal, maw done for worktrees)",
    });

    const allDone = await sleepHandler(ctx("cli", ["--all-done"]));
    expect(allDone.ok).toBe(true);
    expect(allDone.output).toContain("sleep --all-done");

    await expect(sleepHandler(ctx("api", {}))).resolves.toEqual({
      ok: false,
      error: "oracle is required (usage: maw sleep <oracle> [window])",
    });

    sleepLogs = ["sleeping neo"];
    const written: string[] = [];
    await expect(sleepHandler(ctx("api", { oracle: "neo", window: "main" }, (...args) => written.push(args.map(String).join(" "))))).resolves.toEqual({
      ok: true,
      output: undefined,
    });
    expect(sleepCalls).toEqual([{ oracle: "neo", window: "main" }]);
    expect(written).toEqual(["sleeping neo"]);
  });

  test("returns captured logs on cmdSleepOne failure before falling back to thrown message", async () => {
    sleepError = new Error("tmux refused");
    await expect(sleepHandler(ctx("cli", ["neo"]))).resolves.toEqual({
      ok: false,
      error: "tmux refused",
      output: undefined,
    });

    sleepCalls = [];
    sleepLogs = ["about to sleep neo"];
    await expect(sleepHandler(ctx("cli", ["neo", "main"]))).resolves.toEqual({
      ok: false,
      error: "about to sleep neo",
      output: "about to sleep neo",
    });
    expect(sleepCalls).toEqual([{ oracle: "neo", window: "main" }]);
  });
});

describe("dream plugin entrypoint", () => {
  test("parses every CLI flag shape and ignores API args", async () => {
    dreamLogs = ["dream saved"];
    const cli = await dreamHandler(ctx("cli", [
      "--pain",
      "--plan",
      "--gain",
      "--all",
      "--speculate",
      "--between",
      "--help",
      "--project",
      "focus-oracle",
    ]));
    expect(cli).toEqual({ ok: true, output: "dream saved" });
    expect(dreamCalls.at(-1)).toEqual({
      pain: true,
      plan: true,
      gain: true,
      all: true,
      speculate: true,
      between: true,
      help: true,
      project: "focus-oracle",
    });

    const written: string[] = [];
    dreamLogs = ["writer dream"];
    await expect(dreamHandler(ctx("cli", ["-p", "short", "-h"], (...args) => written.push(args.map(String).join(" "))))).resolves.toEqual({
      ok: true,
      output: undefined,
    });
    expect(dreamCalls.at(-1)).toMatchObject({ project: "short", help: true });
    expect(written).toEqual(["writer dream"]);

    await dreamHandler(ctx("cli", ["--project=equals"]));
    expect(dreamCalls.at(-1)).toMatchObject({ project: "equals" });

    await dreamHandler(ctx("api", { project: "ignored" }));
    expect(dreamCalls.at(-1)).toEqual({
      pain: false,
      plan: false,
      gain: false,
      all: false,
      speculate: false,
      between: false,
      help: false,
      project: undefined,
    });
  });

  test("surfaces project parse and implementation errors", async () => {
    await expect(dreamHandler(ctx("cli", ["--project"]))).resolves.toEqual({
      ok: false,
      error: "--project requires a name",
      output: undefined,
    });

    dreamError = new Error("dream failed");
    await expect(dreamHandler(ctx("cli", ["--between"]))).resolves.toEqual({
      ok: false,
      error: "dream failed",
      output: undefined,
    });

    dreamLogs = ["before dream fail"];
    await expect(dreamHandler(ctx("cli", ["--between"]))).resolves.toEqual({
      ok: false,
      error: "before dream fail",
      output: "before dream fail",
    });
  });

  test("routes dream stderr through writer when provided", async () => {
    const written: string[] = [];
    dreamErrorLogs = ["stderr dream line"];

    await expect(dreamHandler(ctx("cli", ["--between"], (...args) => written.push(args.map(String).join(" "))))).resolves.toEqual({
      ok: true,
      output: undefined,
    });

    expect(written).toEqual(["stderr dream line"]);
  });
});

describe("run/send/send-text parsers", () => {
  test("parse helpers preserve dashed payload text while validating required fields", () => {
    expect(runImpl.parseRunArgs(["--verbose", "pane", "ls", "-la", "/tmp"])).toEqual({ target: "pane", text: "ls -la /tmp" });
    expect(runImpl.parseRunArgs(["pane"])).toEqual({ target: "pane", text: "" });
    expect(sendImpl.parseSendArgs(["--flag", "pane", "hello", "--literal"])).toEqual({ target: "pane", text: "hello --literal" });
    expect(sendTextImpl.parseSendTextArgs(["pane", "/awaken"])).toEqual({ target: "pane", text: "/awaken" });

    expect(() => runImpl.parseRunArgs(["--flag"])).toThrow("usage: maw run");
    expect(() => sendImpl.parseSendArgs(["pane"])).toThrow("text is required");
    expect(() => sendTextImpl.parseSendTextArgs(["--flag"])).toThrow("usage: maw send-text");
    expect(() => sendTextImpl.parseSendTextArgs(["pane"])).toThrow("text is required");
  });
});

describe("run/send/send-text local and error delivery", () => {
  test("local send types literally, run submits Enter, and send-text uses the paste-friendly primitive", async () => {
    resolvedTarget = { type: "local", target: "01-local:neo-oracle" };

    const sendOut = await captureConsole(() => sendImpl.cmdSend({ target: "neo", text: "x".repeat(205) }));
    expect(resolveTargetCalls[0]).toMatchObject({ query: "neo", config: configState });
    expect(paneCalls).toEqual(["01-local:neo-oracle"]);
    expect(literalCalls).toEqual([{ target: paneResult, text: "x".repeat(205) }]);
    expect(stripAnsi(sendOut.output)).toContain(`typed → ${paneResult}: ${"x".repeat(200)}…`);

    paneCalls = [];
    literalCalls = [];
    keyCalls = [];
    const runOut = await captureConsole(() => runImpl.cmdRun({ target: "neo", text: "" }));
    expect(paneCalls).toEqual(["01-local:neo-oracle"]);
    expect(literalCalls).toEqual([]);
    expect(keyCalls).toEqual([{ target: paneResult, key: "Enter" }]);
    expect(stripAnsi(runOut.output)).toContain(`ran → ${paneResult}: `);

    paneCalls = [];
    textCalls = [];
    const textOut = await captureConsole(() => sendTextImpl.cmdSendText({ target: "neo", text: "hello" }));
    expect(paneCalls).toEqual(["01-local:neo-oracle"]);
    expect(textCalls).toEqual([{ target: paneResult, text: "hello" }]);
    expect(stripAnsi(textOut.output)).toContain(`sent → ${paneResult}: hello`);
  });

  test("delivery commands report usage, unresolved targets, target errors, and pane resolution failures", async () => {
    await expect(sendImpl.cmdSend({ target: "", text: "hi" })).rejects.toThrow("usage: maw send");
    await expect(runImpl.cmdRun({ target: "", text: "hi" })).rejects.toThrow("usage: maw run");
    await expect(sendTextImpl.cmdSendText({ target: "pane", text: "" })).rejects.toThrow("text is required");

    resolvedTarget = null;
    await expect(sendImpl.cmdSend({ target: "missing", text: "hi" })).rejects.toThrow("could not resolve target: missing");

    resolvedTarget = { type: "error", detail: "ambiguous target", hint: "choose a pane" };
    await expect(sendTextImpl.cmdSendText({ target: "neo", text: "hi" })).rejects.toThrow("ambiguous target — choose a pane");

    resolvedTarget = { type: "local", target: "01-local:neo-oracle" };
    paneError = new Error("no panes");
    await expect(runImpl.cmdRun({ target: "neo", text: "pwd" })).rejects.toThrow("no panes");
  });
});

describe("run/send/send-text peer delivery", () => {
  test("peer routes set enter correctly and render successful targets", async () => {
    resolvedTarget = { type: "peer", node: "mba", peerUrl: "http://peer", target: "remote-pane" };
    curlQueue = [
      { ok: true, data: { ok: true, target: "actual-send" } },
      { ok: true, data: { ok: true, target: "actual-run" } },
      { ok: true, data: { ok: true, target: "actual-text" } },
    ];

    const sendOut = await captureConsole(() => sendImpl.cmdSend({ target: "mba:neo", text: "draft" }));
    const runOut = await captureConsole(() => runImpl.cmdRun({ target: "mba:neo", text: "ship" }));
    const textOut = await captureConsole(() => sendTextImpl.cmdSendText({ target: "mba:neo", text: "awaken" }));

    expect(curlCalls.map((call) => ({ url: call.url, body: JSON.parse(call.init.body), from: call.init.from }))).toEqual([
      { url: "http://peer/api/pane-keys", body: { target: "remote-pane", text: "draft", enter: false }, from: "auto" },
      { url: "http://peer/api/pane-keys", body: { target: "remote-pane", text: "ship", enter: true }, from: "auto" },
      { url: "http://peer/api/pane-keys", body: { target: "remote-pane", text: "awaken", enter: true }, from: "auto" },
    ]);
    expect(stripAnsi(sendOut.output)).toContain("typed ⚡ mba → actual-send: draft");
    expect(stripAnsi(runOut.output)).toContain("ran ⚡ mba → actual-run: ship");
    expect(stripAnsi(textOut.output)).toContain("sent ⚡ mba → actual-text: awaken");
  });

  test("peer failures include data errors, HTTP status, or connection fallback", async () => {
    resolvedTarget = { type: "peer", node: "mba", peerUrl: "http://peer", target: "remote-pane" };

    curlQueue = [{ ok: true, data: { ok: false, error: "denied" } }];
    await expect(sendTextImpl.cmdSendText({ target: "mba:neo", text: "awaken" })).rejects.toThrow(
      "peer send-text failed (mba http://peer): denied",
    );

    curlQueue = [{ ok: false, status: 503, data: {} }];
    await expect(runImpl.cmdRun({ target: "mba:neo", text: "ship" })).rejects.toThrow(
      "peer run failed (mba http://peer): HTTP 503",
    );

    curlQueue = [{ ok: false }];
    await expect(sendImpl.cmdSend({ target: "mba:neo", text: "draft" })).rejects.toThrow(
      "peer send failed (mba http://peer): connection failed",
    );
  });
});
