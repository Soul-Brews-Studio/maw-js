/** Extra isolated coverage for pane/action vendor plugins without real tmux. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type WindowRow = { index: number; name: string };
type Session = { name: string; windows: WindowRow[] };
type ResolveResult =
  | { kind: "match"; match: Session }
  | { kind: "ambiguous"; candidates: Session[] }
  | { kind: "none"; hints?: Session[] };

const attachImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/attach/impl.ts");
const captureImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/capture/impl.ts");
const panesImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/panes/impl.ts");
const tabTalkToImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/tab/internal/talk-to-impl.ts");
const viewImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/view/impl.ts");

let sessions: Session[] = [];
let listSessionsCalls = 0;
let resolveResults = new Map<string, ResolveResult>();
let resolveCalls: Array<{ target: string; sessions: Session[] }> = [];

let hostExecCalls: string[] = [];
let hostExecQueue: Array<string | Error> = [];
let tmuxRunCalls: string[][] = [];
let tmuxRunQueue: Array<string | Error> = [];

let configState: Record<string, any> = {};
let cfgTimeoutCalls: string[] = [];
let curlFetchCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
let curlFetchQueue: Array<{ ok: boolean; status?: number; data?: any } | Error> = [];

let peekCalls: string[] = [];
let sendCalls: Array<{ target: string; message: string; force: boolean }> = [];
let talkCalls: Array<{ target: string; message: string; force: boolean }> = [];

let attachCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
let attachError: Error | null = null;
let attachLog = "";

let captureCalls: Array<{ target: string; opts: Record<string, unknown> }> = [];
let captureError: Error | null = null;
let captureLog = "";

let panesCalls: Array<{ target: string | undefined; opts: Record<string, unknown> }> = [];
let panesError: Error | null = null;
let panesLog = "";

let viewCalls: Array<{
  agent: string;
  windowHint?: string;
  clean: boolean;
  kill: boolean;
  splitAnchor?: string | true;
  extraOpts: Record<string, unknown>;
}> = [];
let viewError: Error | null = null;
let viewLog = "";

let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/sdk", () => ({
  listSessions: async () => {
    listSessionsCalls += 1;
    return sessions;
  },
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    const next = hostExecQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  tmuxCmd: () => "tmux-test",
  tmux: {
    run: async (...args: string[]) => {
      tmuxRunCalls.push(args);
      const next = tmuxRunQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    },
  },
  curlFetch: async (url: string, opts: Record<string, unknown>) => {
    curlFetchCalls.push({ url, opts });
    const next = curlFetchQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? { ok: true, data: {} };
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => configState,
  cfgTimeout: (name: string) => {
    cfgTimeoutCalls.push(name);
    return 1234;
  },
  buildCommandInDir: (dir: string, cmd: string) => `cd ${dir} && ${cmd}`,
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (target: string, seenSessions: Session[]) => {
    resolveCalls.push({ target, sessions: seenSessions });
    return resolveResults.get(target) ?? { kind: "none", hints: [] };
  },
}));

mock.module("maw-js/commands/shared/comm", () => ({
  cmdPeek: async (target: string) => {
    peekCalls.push(target);
  },
  cmdSend: async (target: string, message: string, force = false) => {
    sendCalls.push({ target, message, force });
  },
}));

mock.module(tabTalkToImplPath, () => ({
  cmdTalkTo: async (target: string, message: string, force = false) => {
    talkCalls.push({ target, message, force });
  },
}));

mock.module(attachImplPath, () => ({
  cmdAttach: async (name: string, opts: Record<string, unknown> = {}) => {
    attachCalls.push({ name, opts });
    if (attachLog) console.error(attachLog);
    if (attachError) throw attachError;
    console.log(`attached ${name}`);
  },
}));

mock.module(captureImplPath, () => ({
  cmdCapture: async (target: string, opts: Record<string, unknown> = {}) => {
    captureCalls.push({ target, opts });
    if (captureLog) console.log(captureLog);
    if (captureError) throw captureError;
    console.log(`captured ${target}`);
  },
}));

mock.module(panesImplPath, () => ({
  cmdPanes: async (target?: string, opts: Record<string, unknown> = {}) => {
    panesCalls.push({ target, opts });
    if (panesLog) console.error(panesLog);
    if (panesError) throw panesError;
    console.log(`panes ${target ?? "current"}`);
  },
}));

mock.module(viewImplPath, () => ({
  cmdView: async (
    agent: string,
    windowHint: string | undefined,
    clean = false,
    kill = false,
    splitAnchor?: string | true,
    extraOpts: Record<string, unknown> = {},
  ) => {
    viewCalls.push({ agent, windowHint, clean, kill, splitAnchor, extraOpts });
    if (viewLog) console.log(viewLog);
    if (viewError) throw viewError;
    console.log(`view ${agent}`);
  },
}));

const { cmdZoom } = await import("../../src/vendor/mpr-plugins/zoom/impl.ts?vendor-pane-actions-extra-coverage");
const zoomHandler = (await import("../../src/vendor/mpr-plugins/zoom/index.ts?vendor-pane-actions-extra-coverage")).default;
const { cmdTake } = await import("../../src/vendor/mpr-plugins/take/impl.ts?vendor-pane-actions-extra-coverage");
const takeHandler = (await import("../../src/vendor/mpr-plugins/take/index.ts?vendor-pane-actions-extra-coverage")).default;
const { cmdPing } = await import("../../src/vendor/mpr-plugins/ping/impl.ts?vendor-pane-actions-extra-coverage");
const pingHandler = (await import("../../src/vendor/mpr-plugins/ping/index.ts?vendor-pane-actions-extra-coverage")).default;
const tabHandler = (await import("../../src/vendor/mpr-plugins/tab/index.ts?vendor-pane-actions-extra-coverage")).default;
const attachHandler = (await import("../../src/vendor/mpr-plugins/attach/index.ts?vendor-pane-actions-extra-coverage")).default;
const captureHandler = (await import("../../src/vendor/mpr-plugins/capture/index.ts?vendor-pane-actions-extra-coverage")).default;
const panesHandler = (await import("../../src/vendor/mpr-plugins/panes/index.ts?vendor-pane-actions-extra-coverage")).default;
const viewHandler = (await import("../../src/vendor/mpr-plugins/view/index.ts?vendor-pane-actions-extra-coverage")).default;

function ctx(source: "cli" | "api" | "timer", args: unknown, writer?: (...args: unknown[]) => void) {
  return { source, args, writer } as any;
}

function captureConsole() {
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
}

function output() {
  return [...logs, ...errors].join("\n");
}

function stripAnsi(value: string | undefined) {
  return (value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  sessions = [];
  listSessionsCalls = 0;
  resolveResults = new Map();
  resolveCalls = [];

  hostExecCalls = [];
  hostExecQueue = [];
  tmuxRunCalls = [];
  tmuxRunQueue = [];

  configState = {};
  cfgTimeoutCalls = [];
  curlFetchCalls = [];
  curlFetchQueue = [];

  peekCalls = [];
  sendCalls = [];
  talkCalls = [];

  attachCalls = [];
  attachError = null;
  attachLog = "";
  captureCalls = [];
  captureError = null;
  captureLog = "";
  panesCalls = [];
  panesError = null;
  panesLog = "";
  viewCalls = [];
  viewError = null;
  viewLog = "";

  captureConsole();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("zoom vendor plugin coverage", () => {
  test("handler parses CLI pane flags and toggles a bare target", async () => {
    sessions = [{ name: "Neo", windows: [{ index: 5, name: "shell" }] }];
    resolveResults.set("neo", { kind: "match", match: sessions[0] });

    const result = await zoomHandler(ctx("cli", ["neo", "--pane", "2"]));

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("toggled zoom on Neo:5.2");
    expect(resolveCalls).toEqual([{ target: "neo", sessions }]);
    expect(hostExecCalls).toEqual(["tmux-test resize-pane -Z -t 'Neo:5.2'"]);
  });

  test("handler rejects missing, help, flag-looking, and API bodies without targets", async () => {
    expect(await zoomHandler(ctx("cli", []))).toEqual({ ok: false, error: "usage: maw zoom <target> [--pane N]" });
    expect(await zoomHandler(ctx("cli", ["--pane"]))).toEqual({
      ok: false,
      error: "option requires argument: --pane",
      output: undefined,
    });
    expect(await zoomHandler(ctx("cli", ["--wat"]))).toEqual({
      ok: false,
      error: "\"--wat\" looks like a flag, not a target.\n  usage: maw zoom <target>",
    });
    expect(await zoomHandler(ctx("cli", ["-h"]))).toEqual({ ok: false, error: "usage: maw zoom <target> [--pane N]" });
    expect(await zoomHandler(ctx("api", {}))).toEqual({ ok: false, error: "target is required" });
  });

  test("resolves colon targets and reports ambiguous/missing/failing tmux branches", async () => {
    sessions = [{ name: "alpha-main", windows: [{ index: 0, name: "main" }] }];
    resolveResults.set("alpha", { kind: "match", match: sessions[0] });

    await cmdZoom("alpha:logs", { pane: 1 });
    expect(hostExecCalls).toEqual(["tmux-test resize-pane -Z -t 'alpha-main:logs.1'"]);

    errors = [];
    hostExecCalls = [];
    sessions = [{ name: "maw-one", windows: [] }, { name: "maw-two", windows: [] }];
    resolveResults.set("maw", { kind: "ambiguous", candidates: sessions });
    await expect(cmdZoom("maw:0")).rejects.toThrow("'maw' is ambiguous — matches 2 sessions");
    expect(errors.join("\n")).toContain("maw-one");
    expect(hostExecCalls).toEqual([]);

    errors = [];
    sessions = [{ name: "hinted", windows: [] }];
    resolveResults.set("ghost", { kind: "none", hints: sessions });
    await expect(cmdZoom("ghost:0")).rejects.toThrow("session 'ghost' not found");
    expect(errors.join("\n")).toContain("did you mean");
    expect(errors.join("\n")).toContain("hinted");

    errors = [];
    resolveResults.set("absent", { kind: "none", hints: [] });
    await expect(cmdZoom("absent")).rejects.toThrow("session 'absent' not found");
    expect(errors.join("\n")).toContain("try: maw ls");

    sessions = [{ name: "Neo", windows: [{ index: 0, name: "shell" }] }];
    resolveResults.set("neo", { kind: "match", match: sessions[0] });
    hostExecCalls = [];
    hostExecQueue = [new Error("tmux refused")];
    await expect(cmdZoom("neo")).rejects.toThrow("zoom failed: tmux refused");
    expect(hostExecCalls).toEqual(["tmux-test resize-pane -Z -t 'Neo:0'"]);
  });
});

describe("take vendor plugin coverage", () => {
  test("splits a source window into a new session, tolerates duplicate create and default-window cleanup failures", async () => {
    sessions = [{ name: "src", windows: [{ index: 2, name: "work" }] }];
    hostExecQueue = [
      new Error("duplicate session: work"),
      "/repo/work\n",
      "",
      new Error("no default window"),
    ];

    await cmdTake("src:work");

    expect(hostExecCalls).toEqual([
      "tmux new-session -d -s 'work'",
      "tmux display-message -t 'src:work' -p '#{pane_current_path}'",
      "tmux move-window -s 'src:work' -t 'work:'",
      "tmux kill-window -t 'work:1' 2>/dev/null",
    ]);
    expect(stripAnsi(output())).toContain("src:work → work (new session)");
    expect(stripAnsi(output())).toContain("cwd: /repo/work");
  });

  test("validates source shape, create failures, same-session noops, and missing source/window", async () => {
    await expect(cmdTake("src")).rejects.toThrow("usage: maw take <session>:<window>");
    expect(stripAnsi(output())).toContain("usage: maw take <session>:<window>");

    logs = [];
    errors = [];
    hostExecQueue = [new Error("permission denied")];
    await expect(cmdTake("src:work")).rejects.toThrow("could not create session 'work': permission denied");

    logs = [];
    errors = [];
    hostExecCalls = [];
    await cmdTake("src:work", "src");
    expect(stripAnsi(output())).toContain("source and target are the same session");
    expect(hostExecCalls).toEqual([]);

    sessions = [];
    await expect(cmdTake("src:work", "dest")).rejects.toThrow("session 'src' not found");

    sessions = [{ name: "src", windows: [{ index: 0, name: "other" }] }];
    await expect(cmdTake("src:work", "dest")).rejects.toThrow("window 'work' not found in session 'src'");
  });

  test("wraps move failures after ignoring cwd lookup errors and handler maps CLI/API validation", async () => {
    sessions = [{ name: "src", windows: [{ index: 3, name: "work" }] }];
    hostExecQueue = [new Error("cwd unavailable"), new Error("move refused")];

    await expect(cmdTake("src:3", "dest")).rejects.toThrow("move failed: move refused");
    expect(hostExecCalls).toEqual([
      "tmux display-message -t 'src:work' -p '#{pane_current_path}'",
      "tmux move-window -s 'src:work' -t 'dest:'",
    ]);

    expect(await takeHandler(ctx("cli", []))).toEqual({
      ok: false,
      error: "usage: maw take <session>:<window> [target-session]",
    });
    expect(await takeHandler(ctx("api", {}))).toEqual({ ok: false, error: "source is required" });

    sessions = [{ name: "src", windows: [{ index: 1, name: "logs" }] }];
    hostExecCalls = [];
    hostExecQueue = ["/repo/src\n", ""];
    const result = await takeHandler(ctx("cli", ["src:logs", "dest"]));
    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("src:logs → dest");
  });
});

describe("ping vendor plugin coverage", () => {
  test("prints a no-peers message when config has no targets", async () => {
    configState = { namedPeers: [], peers: [] };

    await cmdPing();

    expect(stripAnsi(output())).toContain("no peers configured");
    expect(curlFetchCalls).toEqual([]);
  });

  test("pings named and legacy peers, de-duplicates named URLs, and renders all result states", async () => {
    configState = {
      namedPeers: [
        { name: "alpha", url: "http://alpha" },
        { name: "beta", url: "http://beta" },
      ],
      peers: ["http://alpha", "http://legacy-ok", "http://legacy-down"],
    };
    curlFetchQueue = [
      { ok: true, data: { enabled: true, tokenPreview: "tok…" } },
      { ok: true, data: { enabled: false } },
      { ok: false, status: 503, data: {} },
      new Error("network down"),
    ];

    await cmdPing();

    expect(curlFetchCalls.map((call) => call.url)).toEqual([
      "http://alpha/api/auth/status",
      "http://beta/api/auth/status",
      "http://legacy-ok/api/auth/status",
      "http://legacy-down/api/auth/status",
    ]);
    expect(cfgTimeoutCalls).toEqual(["ping", "ping", "ping", "ping"]);
    const plain = stripAnsi(output());
    expect(plain).toContain("alpha (http://alpha)");
    expect(plain).toContain("auth: ok (tok…)");
    expect(plain).toContain("beta (http://beta)");
    expect(plain).toContain("auth: off");
    expect(plain).toContain("http://legacy-ok");
    expect(plain).toContain("503");
    expect(plain).toContain("http://legacy-down");
    expect(plain).toContain("unreachable");
  });

  test("pings specific named/legacy nodes and surfaces unknown-node guidance through the handler", async () => {
    configState = {
      namedPeers: [{ name: "alpha", url: "http://alpha" }],
      peers: ["http://legacy-node"],
    };
    curlFetchQueue = [{ ok: true, data: { enabled: true } }];

    let result = await pingHandler(ctx("api", { node: "alpha" }));
    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("alpha");
    expect(curlFetchCalls.at(-1)?.url).toBe("http://alpha/api/auth/status");

    curlFetchQueue = [{ ok: true, data: { enabled: false } }];
    result = await pingHandler(ctx("cli", ["legacy"]));
    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("legacy");
    expect(curlFetchCalls.at(-1)?.url).toBe("http://legacy-node/api/auth/status");

    result = await pingHandler(ctx("cli", ["ghost"]));
    expect(result.ok).toBe(false);
    expect(stripAnsi(result.error)).toContain("known: alpha");
  });
});

describe("tab vendor plugin coverage", () => {
  test("lists current-session tabs and marks the active window", async () => {
    tmuxRunQueue = ["dev\n"];
    hostExecQueue = ["0:shell:1\n2:logs:0\n"];

    const result = await tabHandler(ctx("cli", []));

    expect(result.ok).toBe(true);
    expect(tmuxRunCalls).toEqual([["display-message", "-p", "#S"]]);
    expect(hostExecCalls).toEqual([
      "tmux-test list-windows -t 'dev' -F '#{window_index}:#{window_name}:#{window_active}'",
    ]);
    const plain = stripAnsi(result.output);
    expect(plain).toContain("dev tabs:");
    expect(plain).toContain("0: shell ← you are here");
    expect(plain).toContain("2: logs");
  });

  test("peeks a numeric tab, reports missing tabs, and handles non-tmux callers", async () => {
    tmuxRunQueue = ["dev"];
    hostExecQueue = ["1:editor:0"];

    let result = await tabHandler(ctx("cli", ["1"]));
    expect(result.ok).toBe(true);
    expect(peekCalls).toEqual(["editor"]);

    tmuxRunQueue = ["dev"];
    hostExecQueue = ["2:logs:0"];
    result = await tabHandler(ctx("cli", ["3"]));
    expect(result.ok).toBe(false);
    expect(stripAnsi(result.error)).toContain("available: 2");

    tmuxRunQueue = [new Error("no tmux")];
    result = await tabHandler(ctx("cli", []));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not inside a tmux session");
  });

  test("sends messages and talk-to messages while filtering control flags", async () => {
    tmuxRunQueue = ["dev"];
    hostExecQueue = ["4:neo:0"];
    await tabHandler(ctx("cli", ["4", "hello", "there", "--force"]));
    expect(sendCalls).toEqual([{ target: "neo", message: "hello there", force: true }]);

    tmuxRunQueue = ["dev"];
    hostExecQueue = ["4:neo:0"];
    await tabHandler(ctx("cli", ["4", "--talk", "ping", "--force"]));
    expect(talkCalls).toEqual([{ target: "neo", message: "ping", force: true }]);
  });
});

describe("entrypoint handlers for capture/attach/panes/view", () => {
  test("capture handler validates args, passes CLI/API options, streams writer output, and prefers captured errors", async () => {
    expect(await captureHandler(ctx("cli", []))).toEqual({
      ok: false,
      error: "usage: maw capture <target> [--pane N] [--lines N] [--full]  (see: maw peek for quick glance)",
    });
    expect(await captureHandler(ctx("cli", ["--full"]))).toEqual({
      ok: false,
      error: "usage: maw capture <target> [--pane N] [--lines N] [--full]  (see: maw peek for quick glance)",
    });
    expect(await captureHandler(ctx("cli", ["--wat"]))).toEqual({
      ok: false,
      error: "\"--wat\" looks like a flag, not a target.\n  usage: maw capture <target>  (see: maw peek for quick glance)",
    });
    expect(await captureHandler(ctx("api", {}))).toEqual({ ok: false, error: "target is required" });

    const written: string[] = [];
    let result = await captureHandler(ctx("cli", ["neo", "--pane", "2", "--lines", "10", "--full"], (...args) => {
      written.push(args.map(String).join(" "));
    }));
    expect(result).toEqual({ ok: true, output: undefined });
    expect(written).toEqual(["captured neo"]);
    expect(captureCalls.at(-1)).toEqual({ target: "neo", opts: { pane: 2, lines: 10, full: true } });

    result = await captureHandler(ctx("api", { target: "api-target", pane: 1, lines: 3, full: false }));
    expect(result.ok).toBe(true);
    expect(captureCalls.at(-1)).toEqual({ target: "api-target", opts: { pane: 1, lines: 3, full: false } });

    captureLog = "captured before failure";
    captureError = new Error("impl exploded");
    result = await captureHandler(ctx("cli", ["bad"]));
    expect(result).toEqual({
      ok: false,
      error: "captured before failure",
      output: "captured before failure",
    });
  });

  test("attach handler validates CLI/API input, forces API yes, and reports thrown errors", async () => {
    const usage = "usage: maw attach <name> [--shell [--split|--no-split]] [--dry-run] [-y|--yes]";
    expect(await attachHandler(ctx("cli", []))).toEqual({ ok: false, error: usage });
    expect(await attachHandler(ctx("cli", ["--dry-run"]))).toEqual({ ok: false, error: usage });
    expect(await attachHandler(ctx("cli", ["--wat"]))).toEqual({
      ok: false,
      error: `"--wat" looks like a flag, not an oracle name.\n  ${usage}`,
    });
    expect(await attachHandler(ctx("api", {}))).toEqual({ ok: false, error: "name required" });

    let result = await attachHandler(ctx("api", { name: "neo", dryRun: true }));
    expect(result.ok).toBe(true);
    expect(attachCalls.at(-1)).toEqual({ name: "neo", opts: { dryRun: true, yes: true } });

    result = await attachHandler(ctx("cli", ["neo", "--shell", "--no-split"]));
    expect(result.ok).toBe(true);
    expect(attachCalls.at(-1)).toEqual({
      name: "neo",
      opts: { dryRun: undefined, yes: undefined, shell: true, split: false },
    });

    attachError = new Error("attach impl exploded");
    result = await attachHandler(ctx("cli", ["neo", "--yes"]));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("attach impl exploded");
  });

  test("panes handler validates CLI flags, maps API options, and returns captured failure logs", async () => {
    expect(await panesHandler(ctx("cli", ["--help"]))).toEqual({
      ok: false,
      error: "usage: maw panes [target] [--pid] [--all|-a]  (see: maw pane swap, maw tile)",
    });
    expect(await panesHandler(ctx("cli", ["--wat"]))).toEqual({
      ok: false,
      error: "\"--wat\" looks like a flag, not a target.\n  usage: maw panes [target] [--pid] [--all|-a]  (see: maw pane swap, maw tile)",
    });

    let result = await panesHandler(ctx("api", { target: "neo", pid: true, all: true }));
    expect(result.ok).toBe(true);
    expect(panesCalls.at(-1)).toEqual({ target: "neo", opts: { pid: true, all: true } });

    panesLog = "panes stderr before throw";
    panesError = new Error("panes impl exploded");
    result = await panesHandler(ctx("cli", ["neo"]));
    expect(result).toEqual({
      ok: false,
      error: "panes stderr before throw",
      output: "panes stderr before throw",
    });
  });

  test("view handler validates usage, parses split anchors and flags, and captures impl output/errors", async () => {
    expect(await viewHandler(ctx("cli", []))).toEqual({
      ok: false,
      error: "usage: maw view <agent> [window] [--clean] [--kill] [--readonly|-r] [--split[=<anchor>]]",
    });

    let result = await viewHandler(ctx("cli", ["neo", "logs", "--clean", "--kill", "--readonly", "--split=anchor:2", "--wake", "--no-wake"]));
    expect(result.ok).toBe(true);
    expect(viewCalls.at(-1)).toEqual({
      agent: "neo",
      windowHint: "logs",
      clean: true,
      kill: true,
      splitAnchor: "anchor:2",
      extraOpts: { readonly: true, wake: true, noWake: true },
    });

    result = await viewHandler(ctx("cli", ["neo", "--split"]));
    expect(result.ok).toBe(true);
    expect(viewCalls.at(-1)?.splitAnchor).toBe(true);
    expect(viewCalls.at(-1)?.windowHint).toBeUndefined();

    viewLog = "view log before throw";
    viewError = new Error("view impl exploded");
    result = await viewHandler(ctx("cli", ["bad"]));
    expect(result).toEqual({
      ok: false,
      error: "view log before throw",
      output: "view log before throw",
    });
  });
});
