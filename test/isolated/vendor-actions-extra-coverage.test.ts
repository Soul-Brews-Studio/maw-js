/** Extra isolated coverage for small vendored action handlers and helpers. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Session = { name: string; windows: Array<{ index: number; name: string }> };
type ResolveResult =
  | { kind: "match"; match: Session }
  | { kind: "ambiguous"; candidates: Session[] }
  | { kind: "none"; hints?: Session[] };

const root = join(import.meta.dir, "../..");
const renameImplBase = join(root, "src/vendor/mpr-plugins/rename/src/impl");
const workonImplBase = join(root, "src/vendor/mpr-plugins/workon/impl");

let renameCalls: Array<{ target: string; newName: string }> = [];
let renameError: Error | null = null;
let renameStdout = "";
let renameStderr = "";

let workonCalls: Array<{ repo: string; task?: string }> = [];
let workonError: Error | null = null;
let workonStdout = "";
let workonStderr = "";

let sessions: Session[] = [];
let resolveResults = new Map<string, ResolveResult>();
let resolveCalls: Array<{ target: string; sessions: Session[] }> = [];
let listSessionsCalls = 0;
let hostExecCalls: string[] = [];
let hostExecThrows: unknown = null;

let logs: string[] = [];
let errors: string[] = [];
let warnings: string[] = [];
let tempDirs: string[] = [];
let fetchImpl: typeof fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

const original = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  fetch: globalThis.fetch,
};

function renameImplMock() {
  return {
    cmdRename: async (target: string, newName: string) => {
      renameCalls.push({ target, newName });
      if (renameStdout) console.log(renameStdout);
      if (renameStderr) console.error(renameStderr);
      if (renameError) throw renameError;
      console.log(`renamed ${target} to ${newName}`);
    },
  };
}

function workonImplMock() {
  return {
    cmdWorkon: async (repo: string, task?: string) => {
      workonCalls.push({ repo, task });
      if (workonStdout) console.log(workonStdout);
      if (workonStderr) console.error(workonStderr);
      if (workonError) throw workonError;
      console.log(`workon ${repo}${task ? ` ${task}` : ""}`);
    },
  };
}

mock.module(renameImplBase, renameImplMock);
mock.module(`${renameImplBase}.ts`, renameImplMock);
mock.module(workonImplBase, workonImplMock);
mock.module(`${workonImplBase}.ts`, workonImplMock);

mock.module("maw-js/sdk", () => ({
  listSessions: async () => {
    listSessionsCalls += 1;
    return sessions;
  },
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (hostExecThrows !== null) throw hostExecThrows;
    return "";
  },
  tmuxCmd: () => "tmux-mock",
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (target: string, seenSessions: Session[]) => {
    resolveCalls.push({ target, sessions: seenSessions });
    return resolveResults.get(target) ?? { kind: "none", hints: [] };
  },
}));

const renamePlugin = await import("../../src/vendor/mpr-plugins/rename/src/index.ts?vendor-actions-extra-coverage");
const workonPlugin = await import("../../src/vendor/mpr-plugins/workon/index.ts?vendor-actions-extra-coverage");
const { cmdZoom } = await import("../../src/vendor/mpr-plugins/zoom/impl.ts?vendor-actions-extra-coverage");
const { postHandshake, warnIfPlainHttp } = await import("../../src/vendor/mpr-plugins/pair/handshake.ts?vendor-actions-extra-coverage");
const { syncDir } = await import("../../src/lib/sync-dir.ts?vendor-actions-extra-coverage");

function ctx(source: "cli" | "api" | "timer", args: unknown, writer?: (...args: unknown[]) => void) {
  return { source, args, writer } as any;
}

function fakeResponse(input: { ok: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> }) {
  return {
    ok: input.ok,
    status: input.status ?? 200,
    statusText: input.statusText,
    json: input.json ?? (async () => ({})),
  } as Response;
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function resetConsoleCapture() {
  logs = [];
  errors = [];
  warnings = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
}

beforeEach(() => {
  renameCalls = [];
  renameError = null;
  renameStdout = "";
  renameStderr = "";

  workonCalls = [];
  workonError = null;
  workonStdout = "";
  workonStderr = "";

  sessions = [];
  resolveResults = new Map();
  resolveCalls = [];
  listSessionsCalls = 0;
  hostExecCalls = [];
  hostExecThrows = null;

  fetchCalls = [];
  fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return fakeResponse({ ok: true, json: async () => ({ ok: true, node: "remote", url: "https://remote", federationToken: "tok" }) });
  }) as typeof fetch;
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => fetchImpl(url, init)) as typeof fetch;
  resetConsoleCapture();
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  console.warn = original.warn;
  globalThis.fetch = original.fetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rename vendor action index", () => {
  test("dispatches CLI args, captures output, and exports command metadata", async () => {
    expect(renamePlugin.command).toMatchObject({ name: "rename" });

    const result = await renamePlugin.default(ctx("cli", ["1", "focus"]));

    expect(result).toEqual({ ok: true, output: "renamed 1 to focus" });
    expect(renameCalls).toEqual([{ target: "1", newName: "focus" }]);
  });

  test("uses writer callbacks instead of buffered output when provided", async () => {
    const written: string[] = [];

    const result = await renamePlugin.default(ctx("cli", ["2", "done"], (...args) => written.push(args.map(String).join(" "))));

    expect(result).toEqual({ ok: true, output: undefined });
    expect(written).toEqual(["renamed 2 to done"]);
    expect(renameCalls).toEqual([{ target: "2", newName: "done" }]);
  });

  test("reports usage for missing CLI args and non-CLI invocations", async () => {
    expect(await renamePlugin.default(ctx("cli", ["1"]))).toMatchObject({
      ok: false,
      error: "usage: maw rename <tab# or name> <new-name>  (see: maw tab to list tabs)",
    });
    expect(await renamePlugin.default(ctx("api", { target: "1", newName: "x" }))).toMatchObject({
      ok: false,
      error: "usage: maw rename <tab# or name> <new-name>  (see: maw tab to list tabs)",
    });
  });

  test("prefers captured stderr over thrown errors", async () => {
    renameStderr = "tabs: 0:shell";
    renameError = new Error("tmux exploded");

    const result = await renamePlugin.default(ctx("cli", ["missing", "focus"]));

    expect(result).toEqual({ ok: false, error: "tabs: 0:shell", output: "tabs: 0:shell" });
    expect(renameCalls).toEqual([{ target: "missing", newName: "focus" }]);
  });
});

describe("workon vendor action index", () => {
  test("dispatches repo and optional task args", async () => {
    expect(workonPlugin.command).toMatchObject({ name: "workon" });

    const result = await workonPlugin.default(ctx("cli", ["Soul-Brews-Studio/maw-js", "coverage"]));

    expect(result).toEqual({ ok: true, output: "workon Soul-Brews-Studio/maw-js coverage" });
    expect(workonCalls).toEqual([{ repo: "Soul-Brews-Studio/maw-js", task: "coverage" }]);
  });

  test("reports usage for missing CLI args and API invocations", async () => {
    expect(await workonPlugin.default(ctx("cli", []))).toMatchObject({ ok: false, error: "usage: maw workon <repo> [task] [--layout nested|legacy]" });
    expect(await workonPlugin.default(ctx("api", { repo: "maw-js" }))).toMatchObject({
      ok: false,
      error: "usage: maw workon <repo> [task] [--layout nested|legacy]",
    });
    expect(workonCalls).toEqual([]);
  });

  test("writer callbacks and captured stderr follow the handler branches", async () => {
    const written: string[] = [];
    let result = await workonPlugin.default(ctx("cli", ["maw-js"], (...args) => written.push(args.map(String).join(" "))));
    expect(result).toEqual({ ok: true, output: undefined });
    expect(written).toEqual(["workon maw-js"]);

    workonStderr = "could not open tmux";
    workonError = new Error("hidden failure");
    result = await workonPlugin.default(ctx("cli", ["maw-js", "fix"]));
    expect(result).toEqual({ ok: false, error: "could not open tmux", output: "could not open tmux" });
  });
});

describe("zoom vendor action impl", () => {
  test("requires a target before touching tmux", async () => {
    await expect(cmdZoom("")).rejects.toThrow("usage: maw zoom <target>");
    expect(listSessionsCalls).toBe(0);
    expect(hostExecCalls).toEqual([]);
  });

  test("resolves bare and colon targets and toggles the selected pane", async () => {
    sessions = [{ name: "Neo", windows: [{ index: 7, name: "dev" }] }];
    resolveResults.set("neo", { kind: "match", match: sessions[0] });

    await cmdZoom("neo", { pane: 3 });
    await cmdZoom("neo:logs");

    expect(resolveCalls).toEqual([
      { target: "neo", sessions },
      { target: "neo", sessions },
    ]);
    expect(hostExecCalls).toEqual([
      "tmux-mock resize-pane -Z -t 'Neo:7.3'",
      "tmux-mock resize-pane -Z -t 'Neo:logs'",
    ]);
    expect(stripAnsi(logs.join("\n"))).toContain("toggled zoom on Neo:7.3");
    expect(stripAnsi(logs.join("\n"))).toContain("toggled zoom on Neo:logs");
  });

  test("reports ambiguous and missing sessions for both target forms", async () => {
    sessions = [{ name: "maw-one", windows: [] }, { name: "maw-two", windows: [] }];
    resolveResults.set("maw", { kind: "ambiguous", candidates: sessions });

    await expect(cmdZoom("maw")).rejects.toThrow("'maw' is ambiguous — matches 2 sessions");
    await expect(cmdZoom("maw:0")).rejects.toThrow("'maw' is ambiguous — matches 2 sessions");
    expect(stripAnsi(errors.join("\n"))).toContain("maw-one");
    expect(stripAnsi(errors.join("\n"))).toContain("maw-two");

    errors = [];
    resolveResults.set("ghost", { kind: "none", hints: [{ name: "ghost-main", windows: [] }] });
    await expect(cmdZoom("ghost:0")).rejects.toThrow("session 'ghost' not found");
    expect(stripAnsi(errors.join("\n"))).toContain("did you mean");
    expect(stripAnsi(errors.join("\n"))).toContain("ghost-main");

    errors = [];
    resolveResults.set("absent", { kind: "none", hints: [] });
    await expect(cmdZoom("absent")).rejects.toThrow("session 'absent' not found");
    expect(stripAnsi(errors.join("\n"))).toContain("try: maw ls");
  });

  test("wraps tmux resize failures including non-Error throws", async () => {
    sessions = [{ name: "Neo", windows: [] }];
    resolveResults.set("neo", { kind: "match", match: sessions[0] });
    hostExecThrows = "tmux refused";

    await expect(cmdZoom("neo")).rejects.toThrow("zoom failed: tmux refused");
    expect(hostExecCalls).toEqual(["tmux-mock resize-pane -Z -t 'Neo:0'"]);
  });
});

describe("pair handshake helper", () => {
  test("posts JSON to the encoded pair endpoint and returns success strings", async () => {
    fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return fakeResponse({
        ok: true,
        json: async () => ({ ok: true, node: "remote-node", url: "https://remote.example", federationToken: "token-123" }),
      });
    }) as typeof fetch;

    const result = await postHandshake("https://remote.example/base", "A B", { node: "local", url: "https://local" }, 10);

    expect(result).toEqual({ ok: true, node: "remote-node", url: "https://remote.example", federationToken: "token-123" });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://remote.example/api/pair/A%20B");
    expect(fetchCalls[0].init.method).toBe("POST");
    expect(fetchCalls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({ node: "local", url: "https://local" });
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("normalizes failed responses, bad JSON, and sparse success payloads", async () => {
    fetchImpl = (async () => fakeResponse({ ok: true, json: async () => ({ ok: true }) })) as typeof fetch;
    expect(await postHandshake("https://remote.example", "empty", { node: "n", url: "u" })).toEqual({
      ok: true,
      node: "",
      url: "",
      federationToken: "",
    });

    fetchImpl = (async () => fakeResponse({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "bad code" }) })) as typeof fetch;
    expect(await postHandshake("https://remote.example", "bad", { node: "n", url: "u" })).toEqual({
      ok: false,
      error: "bad code",
      status: 409,
    });

    fetchImpl = (async () => fakeResponse({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => { throw new Error("not json"); } })) as typeof fetch;
    expect(await postHandshake("https://remote.example", "bad-json", { node: "n", url: "u" })).toEqual({
      ok: false,
      error: "Service Unavailable",
      status: 503,
    });
  });

  test("classifies aborts and network failures", async () => {
    fetchImpl = (async () => { throw Object.assign(new Error("operation aborted"), { name: "AbortError" }); }) as typeof fetch;
    expect(await postHandshake("https://remote.example", "slow", { node: "n", url: "u" })).toEqual({
      ok: false,
      error: "timeout",
      status: 0,
    });

    fetchImpl = (async () => { throw new Error("network boom"); }) as typeof fetch;
    expect(await postHandshake("https://remote.example", "offline", { node: "n", url: "u" })).toEqual({
      ok: false,
      error: "network boom",
      status: 0,
    });

    fetchImpl = (async () => { throw "offline"; }) as typeof fetch;
    expect(await postHandshake("https://remote.example", "string", { node: "n", url: "u" })).toEqual({
      ok: false,
      error: "network_error",
      status: 0,
    });
  });

  test("warns only for plain HTTP beyond loopback and ignores malformed URLs", () => {
    warnIfPlainHttp("http://example.com:5002");
    warnIfPlainHttp("http://localhost:5002");
    warnIfPlainHttp("http://127.0.0.1:5002");
    warnIfPlainHttp("https://example.com:5002");
    warnIfPlainHttp("not a url");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pairing over plain HTTP");
  });
});

describe("vendored syncDir helper", () => {
  function tmpRoot() {
    const dir = mkdtempSync(join(tmpdir(), "maw-sync-dir-"));
    tempDirs.push(dir);
    return dir;
  }

  test("copies only missing files recursively and preserves existing destination files", () => {
    const base = tmpRoot();
    const src = join(base, "src");
    const dst = join(base, "dst");
    mkdirSync(join(src, "nested"), { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "keep.txt"), "source-new");
    writeFileSync(join(src, "nested", "copy.txt"), "nested-new");
    writeFileSync(join(dst, "keep.txt"), "dest-old");

    expect(syncDir(src, dst)).toBe(1);
    expect(readFileSync(join(dst, "keep.txt"), "utf8")).toBe("dest-old");
    expect(readFileSync(join(dst, "nested", "copy.txt"), "utf8")).toBe("nested-new");
    expect(syncDir(src, dst)).toBe(0);
  });

  test("returns zero for missing sources, unreadable listings, and failed copy setup", () => {
    const base = tmpRoot();
    expect(syncDir(join(base, "missing"), join(base, "dst"))).toBe(0);

    const fileSource = join(base, "source-file");
    writeFileSync(fileSource, "not a directory");
    expect(syncDir(fileSource, join(base, "out"))).toBe(0);

    const src = join(base, "src");
    const dstFile = join(base, "dst-file");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "blocked.txt"), "copy me");
    writeFileSync(dstFile, "blocks mkdir");

    expect(syncDir(src, dstFile)).toBe(0);
    expect(existsSync(join(dstFile, "blocked.txt"))).toBe(false);
  });
});
