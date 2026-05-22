import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sdkPath = import.meta.resolve("../../src/sdk/index.ts");
const snapshotPath = import.meta.resolve("../../src/core/fleet/snapshot.ts");
const wakeCmdPath = import.meta.resolve("../../src/commands/shared/wake-cmd.ts");
const configPath = import.meta.resolve("../../src/config.ts");
const transportsPath = import.meta.resolve("../../src/transports/index.ts");

let sessions: unknown[] = [];
let listSessionsError: Error | null = null;
let snapshot: any = null;
let wakeCalls: unknown[][] = [];
let wakeErrorFor: string | null = null;
let ttyAnswer = "n\n";
let transportStatuses: Array<{ name: string; connected: boolean }> = [];
let config: Record<string, any> = {};
let logs: string[] = [];
let writes: string[] = [];

mock.module(sdkPath, () => ({
  listSessions: async () => {
    if (listSessionsError) throw listSessionsError;
    return sessions;
  },
}));

mock.module(snapshotPath, () => ({
  latestSnapshot: () => snapshot,
}));

mock.module(wakeCmdPath, () => ({
  cmdWake: async (...args: unknown[]) => {
    wakeCalls.push(args);
    if (args[0] === wakeErrorFor) throw new Error("wake failed");
  },
}));

mock.module("fs", () => ({
  openSync: () => 7,
  readSync: (_fd: number, buf: Uint8Array) => {
    const bytes = new TextEncoder().encode(ttyAnswer);
    buf.set(bytes);
    return bytes.length;
  },
  closeSync: () => undefined,
}));

mock.module(configPath, () => ({
  loadConfig: () => config,
}));

mock.module(transportsPath, () => ({
  getTransportRouter: () => ({
    status: () => transportStatuses,
  }),
}));

const { maybeAutoRestore } = await import("../../src/cli/auto-restore.ts?auto-restore-transport");
const { cmdTransportStatus } = await import("../../src/commands/shared/transport.ts?auto-restore-transport");

const originalLog = console.log;
const originalWrite = process.stdout.write;
const originalCi = process.env.CI;
const originalNoPrompt = process.env.MAW_NO_PROMPT;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

beforeEach(() => {
  delete process.env.CI;
  delete process.env.MAW_NO_PROMPT;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  sessions = [];
  listSessionsError = null;
  snapshot = null;
  wakeCalls = [];
  wakeErrorFor = null;
  ttyAnswer = "n\n";
  transportStatuses = [];
  config = {};
  logs = [];
  writes = [];
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalWrite;
  if (originalCi === undefined) delete process.env.CI;
  else process.env.CI = originalCi;
  if (originalNoPrompt === undefined) delete process.env.MAW_NO_PROMPT;
  else process.env.MAW_NO_PROMPT = originalNoPrompt;
  Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
});

describe("auto restore startup helper", () => {
  test("skips help/no-command/live-session/no-snapshot/stale-snapshot paths", async () => {
    await maybeAutoRestore(undefined);
    await maybeAutoRestore("--help");
    await maybeAutoRestore("-h");
    expect(wakeCalls).toEqual([]);

    sessions = [{ name: "live" }];
    await maybeAutoRestore("wake");
    expect(wakeCalls).toEqual([]);

    sessions = [];
    snapshot = null;
    await maybeAutoRestore("wake");
    expect(wakeCalls).toEqual([]);

    snapshot = { timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), sessions: [{ name: "01-old" }] };
    await maybeAutoRestore("wake");
    expect(wakeCalls).toEqual([]);
  });

  test("swallows list/session errors and handles declined restore prompts", async () => {
    listSessionsError = new Error("tmux unavailable");
    await maybeAutoRestore("wake");
    expect(wakeCalls).toEqual([]);

    listSessionsError = null;
    snapshot = { timestamp: new Date(Date.now() - 10 * 60_000).toISOString(), sessions: [{ name: "01-alpha" }] };
    ttyAnswer = "no\n";
    await maybeAutoRestore("wake");
    expect(writes.join("")).toContain("Restore all?");
    expect(wakeCalls).toEqual([]);
  });

  test("accepted snapshots wake each oracle and report per-session failures", async () => {
    snapshot = {
      timestamp: new Date(Date.now() - 65 * 60_000).toISOString(),
      sessions: [{ name: "01-alpha" }, { name: "02-beta" }],
    };
    wakeErrorFor = "beta";
    ttyAnswer = "yes\n";

    await maybeAutoRestore("wake");

    expect(wakeCalls).toEqual([["alpha", { attach: false }], ["beta", { attach: false }]]);
    expect(logs.join("\n")).toContain("Last snapshot: 2 sessions (1h ago)");
    expect(logs.join("\n")).toContain("01-alpha");
    expect(logs.join("\n")).toContain("02-beta: wake failed");
    expect(writes.join("")).toContain("Restore all?");
  });
});

describe("transport status command", () => {
  test("prints connected/disconnected transports, registry, and config hints", async () => {
    config = {
      node: "white",
      peers: ["http://peer:3456"],
      agents: { neo: "white", beta: "black" },
    };
    transportStatuses = [
      { name: "tmux", connected: true },
      { name: "http-federation", connected: false },
      { name: "lora", connected: false },
      { name: "custom", connected: true },
    ];

    await cmdTransportStatus();

    const out = logs.join("\n");
    expect(out).toContain("Transport Status");
    expect(out).toContain("node: white");
    expect(out).toContain("tmux");
    expect(out).toContain("http-federation");
    expect(out).toContain("1 peer(s)");
    expect(out).toContain("neo → white (local)");
    expect(out).toContain("beta → black");
    expect(out).not.toContain("Configure in maw.config.json");
  });

  test("prints defaults and configuration hints when peers/agents are absent", async () => {
    config = {};
    transportStatuses = [{ name: "http-federation", connected: false }];

    await cmdTransportStatus();

    const out = logs.join("\n");
    expect(out).toContain("node: local");
    expect(out).toContain("no peers");
    expect(out).toContain("Configure in maw.config.json");
    expect(out).toContain('"peers": ["http://host:3456"]');
    expect(out).toContain('"agents": { "neo": "white" }');
  });
});
