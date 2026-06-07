/** Isolated entrypoint coverage for small vendor command plugins. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testRoot = mkdtempSync(join(tmpdir(), "maw-vendor-command-plugins-"));

const restartImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/restart/impl.ts");

type ContactRecord = {
  maw?: string;
  thread?: string;
  inbox?: string | null;
  repo?: string | null;
  notes?: string;
  retired?: boolean;
};

let psiPath = "";
let configState: Record<string, any> = {};
let savedConfigs: Array<Record<string, any>> = [];
let saveConfigError: Error | null = null;

let restartCalls: Array<{ noUpdate?: boolean; ref?: string }> = [];
let restartError: Error | null = null;

let tmuxRunCalls: string[][] = [];
let tmuxResponses: string[] = [];
let spawnCalls: Array<{ cmd: string[]; opts?: any }> = [];
let spawnResponses: Array<{ stdout?: string; stderr?: string; code?: number }> = [];

let sessions: any[] = [];
let resolvedTarget: any = null;
let resolveTargetCalls: Array<{ query: string; config: Record<string, any>; sessions: any[] }> = [];
let paneTarget = "";
let paneCalls: string[] = [];
let sendKeyCalls: Array<{ target: string; key: string }> = [];

const originalLog = console.log;
const originalError = console.error;
const originalSpawn = Bun.spawn;
const originalTmuxEnv = process.env.TMUX;

mock.module("maw-js/config", () => ({
  loadConfig: () => configState,
  saveConfig: (next: Record<string, any>) => {
    savedConfigs.push(next);
    if (saveConfigError) throw saveConfigError;
    configState = { ...configState, ...next };
  },
}));

mock.module(restartImplPath, () => ({
  cmdRestart: async (opts: { noUpdate?: boolean; ref?: string } = {}) => {
    restartCalls.push(opts);
    if (restartError) throw restartError;
    console.log(`restart:${opts.noUpdate ? "skip" : "update"}:${opts.ref ?? "default"}`);
  },
}));

mock.module("maw-js/core/transport/tmux", () => ({
  Tmux: class {
    async run(...args: string[]) {
      tmuxRunCalls.push(args);
      return tmuxResponses.shift() ?? "";
    }
  },
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  resolveTarget: (query: string, config: Record<string, any>, listedSessions: any[]) => {
    resolveTargetCalls.push({ query, config, sessions: listedSessions });
    return resolvedTarget;
  },
  tmux: {
    sendKeys: async (target: string, key: string) => {
      sendKeyCalls.push({ target, key });
    },
  },
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  resolveOraclePane: async (target: string) => {
    paneCalls.push(target);
    return paneTarget;
  },
}));

const contactsHandler = (await import(
  "../../src/vendor/mpr-plugins/contacts/index.ts?vendor-command-plugins-coverage"
)).default;
const onHandler = (await import("../../src/vendor/mpr-plugins/on/index.ts?vendor-command-plugins-coverage")).default;
const { cmdPr } = await import("../../src/vendor/mpr-plugins/pr/impl.ts?vendor-command-plugins-coverage");
const restartHandler = (await import(
  "../../src/vendor/mpr-plugins/restart/index.ts?vendor-command-plugins-coverage"
)).default;
const { cmdSendEnter, parseSendEnterArgs } = await import(
  "../../src/vendor/mpr-plugins/send-enter/impl.ts?vendor-command-plugins-coverage"
);

function stream(text = "") {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function installSpawnMock() {
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], opts?: any) => {
    spawnCalls.push({ cmd, opts });
    const next = spawnResponses.shift() ?? {};
    return {
      stdout: stream(next.stdout ?? ""),
      stderr: stream(next.stderr ?? ""),
      exited: Promise.resolve(next.code ?? 0),
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
}

async function captureConsole<T>(fn: () => T | Promise<T>) {
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), output: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function contactsFile() {
  return join(psiPath, "contacts.json");
}

function readContacts(): Record<string, ContactRecord> {
  return JSON.parse(readFileSync(contactsFile(), "utf-8")).contacts;
}

function ctx(source: string, args: unknown, writer?: (...args: unknown[]) => void) {
  return { source, args, writer } as any;
}

beforeEach(() => {
  psiPath = mkdtempSync(join(testRoot, "psi-"));
  configState = { psiPath, triggers: [], node: "local-node" };
  savedConfigs = [];
  saveConfigError = null;

  restartCalls = [];
  restartError = null;

  tmuxRunCalls = [];
  tmuxResponses = [];
  spawnCalls = [];
  spawnResponses = [];
  installSpawnMock();

  sessions = [];
  resolvedTarget = null;
  resolveTargetCalls = [];
  paneTarget = "maw:neo.1";
  paneCalls = [];
  sendKeyCalls = [];

  process.env.TMUX = originalTmuxEnv;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
  if (originalTmuxEnv === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmuxEnv;
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("contacts vendor command plugin entrypoint", () => {
  test("lists empty contacts, adds with a writer, and persists contact fields", async () => {
    const empty = await contactsHandler(ctx("cli", []));
    expect(empty).toMatchObject({ ok: true });
    expect(stripAnsi(empty.output ?? "")).toContain("no contacts");

    const written: string[] = [];
    const added = await contactsHandler(ctx("cli", [
      "add",
      "neo",
      "--maw",
      "white:neo",
      "--thread",
      "thread-1",
      "--repo",
      "/repo/neo",
      "--notes",
      "fast lane",
    ], (...args) => written.push(args.map(String).join(" "))));

    expect(added).toEqual({ ok: true, output: undefined });
    expect(stripAnsi(written.join("\n"))).toContain("contact neo saved");
    expect(readContacts().neo).toMatchObject({
      maw: "white:neo",
      thread: "thread-1",
      repo: "/repo/neo",
      notes: "fast lane",
    });

    const listed = await contactsHandler(ctx("cli", []));
    expect(stripAnsi(listed.output ?? "")).toContain("CONTACTS (1)");
    expect(stripAnsi(listed.output ?? "")).toContain("neo");
  });

  test("covers remove validation, API add/list/remove, and unknown API actions", async () => {
    const missingName = await contactsHandler(ctx("cli", ["rm"]));
    expect(missingName).toEqual({ ok: false, error: "name required" });

    const apiMissingName = await contactsHandler(ctx("api", { method: "POST", action: "add" }));
    expect(apiMissingName).toEqual({ ok: false, error: "name required" });

    const added = await contactsHandler(ctx("api", {
      method: "POST",
      action: "add",
      name: "maya",
      transport: "mba:maya",
    }));
    expect(added.ok).toBe(true);
    expect(readContacts().maya.maw).toBe("mba:maya");

    const apiList = await contactsHandler(ctx("api", { method: "GET" }));
    expect(stripAnsi(apiList.output ?? "")).toContain("maya");

    const unknown = await contactsHandler(ctx("api", {
      method: "POST",
      action: "wat",
      name: "maya",
    }));
    expect(unknown).toEqual({ ok: false, error: "unknown action: wat" });

    const removed = await contactsHandler(ctx("api", { method: "POST", action: "rm", name: "maya" }));
    expect(removed.ok).toBe(true);
    expect(readContacts().maya.retired).toBe(true);
  });

  test("falls back to list for non-cli/non-api sources", async () => {
    const result = await contactsHandler(ctx("timer", {}));
    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output ?? "")).toContain("no contacts");
    expect(existsSync(contactsFile())).toBe(false);
  });
});

describe("on vendor command plugin entrypoint", () => {
  test("prints usage when required CLI parts are missing", async () => {
    const result = await onHandler(ctx("cli", ["neo", "idle"]));

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output ?? "");
    expect(output).toContain("Usage: maw on <oracle>");
    expect(output).toContain("Events: agent-idle, agent-wake, agent-crash");
    expect(savedConfigs).toEqual([]);
  });

  test("saves once triggers with timeout while filtering flag tokens from action", async () => {
    configState = { ...configState, triggers: [{ name: "existing", on: "agent-wake" }] };

    const result = await onHandler(ctx("cli", [
      "neo",
      "idle",
      "--once",
      "--timeout",
      "45",
      "maw",
      "hey",
      "homekeeper",
      "neo done",
    ]));

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output ?? "")).toContain("trigger added: on neo idle [once] → maw hey homekeeper neo done");
    expect(savedConfigs).toEqual([{
      triggers: [
        { name: "existing", on: "agent-wake" },
        {
          on: "agent-idle",
          repo: "neo",
          timeout: 45,
          action: "maw hey homekeeper neo done",
          name: "on-neo-idle",
          once: true,
        },
      ],
    }]);
  });

  test("returns captured setup errors from saveConfig", async () => {
    configState = { ...configState, triggers: [] };
    saveConfigError = new Error("config locked");

    const result = await onHandler(ctx("cli", ["neo", "wake", "maw", "wake", "neo"]));

    expect(result).toMatchObject({ ok: false, error: "config locked" });
    expect(savedConfigs).toEqual([{
      triggers: [{
        on: "agent-wake",
        repo: "neo",
        timeout: 30,
        action: "maw wake neo",
        name: "on-neo-wake",
        once: undefined,
      }],
    }]);
  });
});

describe("pr vendor command implementation", () => {
  test("rejects calls outside tmux before querying pane state", async () => {
    delete process.env.TMUX;

    await expect(cmdPr()).rejects.toThrow("not in a tmux session");
    expect(tmuxRunCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });

  test("creates a linked issue PR from a selected tmux window cwd", async () => {
    process.env.TMUX = "/tmp/tmux-test";
    tmuxResponses = ["maw-session\n", "/repo/maw-js\n"];
    spawnResponses = [
      { stdout: "agents/issue-123-fast-coverage\n" },
      { stdout: "https://github.com/Soul-Brews-Studio/maw-js/pull/123\n" },
    ];

    const { output } = await captureConsole(() => cmdPr("work"));

    expect(tmuxRunCalls).toEqual([
      ["display-message", "-p", "#{session_name}"],
      ["display-message", "-t", "maw-session:work", "-p", "#{pane_current_path}"],
    ]);
    expect(spawnCalls).toEqual([
      {
        cmd: ["git", "-C", "/repo/maw-js", "branch", "--show-current"],
        opts: { stdout: "pipe", stderr: "pipe" },
      },
      {
        cmd: ["gh", "pr", "create", "--title", "Issue 123 Fast Coverage", "--body", "Closes #123"],
        opts: { stdout: "pipe", stderr: "pipe", cwd: "/repo/maw-js" },
      },
    ]);
    expect(stripAnsi(output)).toContain('creating PR: "Issue 123 Fast Coverage"');
    expect(stripAnsi(output)).toContain("linking to issue #123");
    expect(stripAnsi(output)).toContain("https://github.com/Soul-Brews-Studio/maw-js/pull/123");
  });

  test("rejects detached HEAD and propagates gh failures", async () => {
    process.env.TMUX = "/tmp/tmux-test";
    tmuxResponses = ["/repo/maw-js\n"];
    spawnResponses = [{ stdout: "\n" }];
    await expect(captureConsole(() => cmdPr())).rejects.toThrow("detached HEAD");

    tmuxResponses = ["/repo/maw-js\n"];
    spawnResponses = [
      { stdout: "feature/no-issue\n" },
      { stderr: "gh failed\n", code: 1 },
    ];
    await expect(captureConsole(() => cmdPr())).rejects.toThrow("gh pr create failed (exit 1)");
  });
});

describe("restart vendor command plugin entrypoint", () => {
  test("short-circuits help before invoking restart implementation", async () => {
    const { result, output } = await captureConsole(() => restartHandler(ctx("cli", ["--help"])));

    expect(result).toMatchObject({ ok: true });
    expect(result.output).toContain("usage: maw restart");
    expect(output).toContain("usage: maw restart");
    expect(restartCalls).toEqual([]);
  });

  test("supports old ctx and new positional dispatcher shapes", async () => {
    const written: string[] = [];
    const oldResult = await restartHandler(ctx("cli", ["--no-update", "--ref", "alpha"], (...args) => {
      written.push(args.map(String).join(" "));
    }));
    expect(oldResult).toEqual({ ok: true, output: undefined });
    expect(written).toEqual(["restart:skip:alpha"]);

    const newResult = await restartHandler(["--ref", "feature/ref"]);
    expect(newResult).toEqual({ ok: true, output: "restart:update:feature/ref" });
    expect(restartCalls).toEqual([
      { noUpdate: true, ref: "alpha" },
      { noUpdate: false, ref: "feature/ref" },
    ]);
  });

  test("returns implementation failures without leaking patched console methods", async () => {
    restartError = new Error("restart exploded");

    const result = await restartHandler(ctx("api", {}));

    expect(result).toEqual({ ok: false, error: "restart exploded", output: undefined });
    expect(restartCalls).toEqual([{ noUpdate: false, ref: undefined }]);
  });
});

describe("send-enter vendor command implementation", () => {
  test("parses target/count forms and validates positive counts", () => {
    expect(parseSendEnterArgs(["neo"])).toEqual({ target: "neo", count: 1 });
    expect(parseSendEnterArgs(["neo", "--N", "3"])).toEqual({ target: "neo", count: 3 });
    expect(parseSendEnterArgs(["--N", "2", "neo"])).toEqual({ target: "neo", count: 2 });
    expect(parseSendEnterArgs(["neo", "--n=4"])).toEqual({ target: "neo", count: 4 });
    expect(() => parseSendEnterArgs(["neo", "--N", "0"])).toThrow("--N requires a positive integer");
    expect(() => parseSendEnterArgs([])).toThrow("usage: maw send-enter");
  });

  test("resolves local targets, clamps command count to one, and sends Enter keys", async () => {
    sessions = [{ name: "maw", windows: [{ name: "neo" }] }];
    resolvedTarget = { type: "local", target: "neo" };
    paneTarget = "maw:neo.2";

    const { output } = await captureConsole(() => cmdSendEnter({ target: "neo", count: 0 }));

    expect(resolveTargetCalls).toEqual([{ query: "neo", config: configState, sessions }]);
    expect(paneCalls).toEqual(["neo"]);
    expect(sendKeyCalls).toEqual([{ target: "maw:neo.2", key: "Enter" }]);
    expect(stripAnsi(output)).toContain("delivered → maw:neo.2: Enter");

    await captureConsole(() => cmdSendEnter({ target: "neo", count: 3 }));
    expect(sendKeyCalls.slice(1)).toEqual([
      { target: "maw:neo.2", key: "Enter" },
      { target: "maw:neo.2", key: "Enter" },
      { target: "maw:neo.2", key: "Enter" },
    ]);
  });

  test("reports unresolved, ambiguous, peer, and missing-target failures", async () => {
    await expect(cmdSendEnter({ target: "" })).rejects.toThrow("usage: maw send-enter");

    resolvedTarget = null;
    await expect(cmdSendEnter({ target: "missing" })).rejects.toThrow("could not resolve target: missing");

    resolvedTarget = { type: "error", detail: "ambiguous target", hint: "choose a pane" };
    await expect(cmdSendEnter({ target: "neo" })).rejects.toThrow("ambiguous target — choose a pane");

    resolvedTarget = { type: "peer", node: "white", target: "neo" };
    await expect(cmdSendEnter({ target: "white:neo" })).rejects.toThrow(
      "send-enter: cross-node target 'white:neo' (node 'white') not yet supported",
    );
  });
});
