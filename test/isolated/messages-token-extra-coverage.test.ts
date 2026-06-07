import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChild from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildMessageLifecycleFeedEvent } from "../../src/lib/message-events";
import { listMessageLedgerEvents, messageLedgerDbPath } from "../../src/vendor/mpr-plugins/messages/ledger";
import { setRunOverride, type RunOptions, type RunResult } from "../../src/vendor/mpr-plugins/token/lib";
import { buildEnvrcContent, cmdUse } from "../../src/vendor/mpr-plugins/token/use";

let tmpHome = "";
let tmpProject = "";
const savedHome = process.env.MAW_HOME;
const savedConfig = process.env.MAW_CONFIG_DIR;
const savedEngineUrl = process.env.MAW_ENGINE_URL;
const savedPort = process.env.MAW_PORT;
const savedMessagesPort = process.env.MAW_MESSAGES_PORT;
const savedArgv = [...process.argv];
const savedKill = process.kill;
const savedFetch = global.fetch;

let spawnPid: number | null = 1234;
let spawnShouldThrow = false;
let spawnWritesLog = false;
let spawnUnrefs = 0;
let spawnCalls: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];

mock.module("child_process", () => ({
  ...realChild,
  spawn: (command: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    spawnCalls.push({ command, args, env: opts.env });
    if (spawnShouldThrow) throw new Error("spawn exploded");
    if (spawnWritesLog) {
      mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
      writeFileSync(join(tmpHome, "engine-plugins", "messages.log"), "booting\nregistration never completed\n", "utf-8");
    }
    return {
      pid: spawnPid,
      unref: () => {
        spawnUnrefs += 1;
      },
    } as any;
  },
}));

const { default: messagesHandler, messagesEngineFetch, onEvent } = await import("../../src/vendor/mpr-plugins/messages/index");

let passEntries = new Set<string>();
let direnvOk = true;
let runCalls: Array<{ cmd: string[]; opts?: RunOptions }> = [];

function runResult(ok: boolean, stdout = "", stderr = ""): RunResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

function resetTokenRunner() {
  passEntries = new Set(["claude/token-demo", "claude/token-fresh"]);
  direnvOk = true;
  runCalls = [];
  setRunOverride((cmd: string[], opts?: RunOptions) => {
    runCalls.push({ cmd, opts });
    if (cmd[0] === "pass" && cmd[1] === "show") {
      return runResult(passEntries.has(cmd[2] ?? ""));
    }
    if (cmd[0] === "direnv" && cmd[1] === "allow") {
      return runResult(direnvOk, "", direnvOk ? "" : "direnv denied");
    }
    return runResult(false, "", `unexpected command: ${cmd.join(" ")}`);
  });
}

function resetSpawn() {
  spawnPid = 1234;
  spawnShouldThrow = false;
  spawnWritesLog = false;
  spawnUnrefs = 0;
  spawnCalls = [];
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-messages-token-home-"));
  tmpProject = mkdtempSync(join(tmpdir(), "maw-token-project-"));
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  process.argv = [...savedArgv];
  process.kill = savedKill;
  global.fetch = savedFetch;
  resetSpawn();
  resetTokenRunner();
});

afterEach(() => {
  restoreEnv("MAW_HOME", savedHome);
  restoreEnv("MAW_CONFIG_DIR", savedConfig);
  restoreEnv("MAW_ENGINE_URL", savedEngineUrl);
  restoreEnv("MAW_PORT", savedPort);
  restoreEnv("MAW_MESSAGES_PORT", savedMessagesPort);
  process.argv = [...savedArgv];
  process.kill = savedKill;
  global.fetch = savedFetch;
  setRunOverride(null);
  rmSync(tmpHome, { force: true, recursive: true });
  rmSync(tmpProject, { force: true, recursive: true });
});

function makeEngineStub(options: {
  registrations?: Array<Record<string, unknown>>;
  registerStatus?: number;
  registerText?: string;
  stickyRegistration?: boolean;
} = {}) {
  let registrations = [...(options.registrations ?? [])];
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
        return Response.json({ ok: true, registrations });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/register") {
        if (options.registerStatus && options.registerStatus >= 400) {
          return new Response(options.registerText ?? "register failed", { status: options.registerStatus });
        }
        const body = await req.json().catch(() => ({}));
        registrations = [body as Record<string, unknown>];
        return Response.json({ ok: true, received: body });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        if (!options.stickyRegistration) registrations = [];
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
}

function writePid(pid: number | string) {
  mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
  writeFileSync(join(tmpHome, "engine-plugins", "messages.pid"), `${pid}\n`, "utf-8");
}

describe("messages plugin extra coverage", () => {
  test("handler ignores non-lifecycle message sends and emits empty-ledger text through ctx.writer", async () => {
    await onEvent({
      event: "MessageSend",
      oracle: "oracle",
      host: "host",
      data: { malformed: true },
    } as any);
    await onEvent({
      event: "Notification",
      oracle: "oracle",
      host: "host",
      data: { id: "ignored" },
    } as any);

    const writes: string[] = [];
    const result = await messagesHandler({
      source: "cli",
      args: ["--limit", "--direction", "sideways", "--state", "lost"],
      writer: (line: string) => writes.push(line),
    } as any);

    expect(result).toEqual({ ok: true, output: "" });
    expect(writes).toEqual([`no messages recorded (${messageLedgerDbPath()})`]);
    expect(listMessageLedgerEvents({ limit: 10 })).toEqual([]);
  });

  test("engine fetch handles bad event JSON, /messages queries, and valid forwarded records", async () => {
    const bad = await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    }));
    expect(await bad.json()).toEqual({ ok: true, recorded: false });

    const event = buildMessageLifecycleFeedEvent({
      id: "forwarded-extra",
      ts: "2026-05-18T00:00:00.000Z",
      direction: "forwarded",
      state: "queued",
      channel: "hey",
      route: "relay",
      from: "node/a",
      to: "node/b",
      target: "node/b.agent",
      text: "needle forwarded message",
      signed: true,
    });
    const recorded = await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }));
    expect(await recorded.json()).toEqual({ ok: true, recorded: true });

    const queried = await messagesEngineFetch(new Request("http://plugin.local/messages?limit=&to=node/b&direction=forwarded&state=queued&q=needle"));
    expect(await queried.json()).toMatchObject({
      ok: true,
      total: 1,
      messages: [{ id: "forwarded-extra", direction: "forwarded", state: "queued" }],
    });
  });

  test("serve returns register failure after trimming MAW_ENGINE_URL and using MAW_MESSAGES_PORT", async () => {
    const engine = makeEngineStub({ registerStatus: 503, registerText: "engine offline" });
    process.env.MAW_ENGINE_URL = `http://127.0.0.1:${engine.port}///`;
    process.env.MAW_MESSAGES_PORT = "0";

    try {
      const result = await messagesHandler({ source: "cli", args: ["serve"] });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("engine register failed 503: engine offline");
    } finally {
      engine.stop(true);
    }
  });

  test("serve --detach reports no child PID and uses maw command fallback without argv", async () => {
    const engine = makeEngineStub();
    spawnPid = null;
    process.argv = [];

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`, "--port", "4321"],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("failed to spawn maw messages serve: no child PID");
      expect(spawnCalls).toMatchObject([{
        command: "maw",
        args: ["messages", "serve", "--engine", `http://127.0.0.1:${engine.port}`, "--port", "4321"],
      }]);
      expect(spawnUnrefs).toBe(0);
    } finally {
      engine.stop(true);
    }
  });

  test("serve --detach times out cleanly and includes the supervised log tail", async () => {
    const engine = makeEngineStub();
    spawnPid = 2468;
    spawnWritesLog = true;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("maw messages serve --detach did not register /api/message-ledger");
      expect(result.error).toContain("pid: 2468");
      expect(result.error).toContain("tail:\nbooting\nregistration never completed");
      expect(spawnUnrefs).toBe(1);
    } finally {
      engine.stop(true);
    }
  });

  test("stop handles a SIGTERM race where the process is already gone", async () => {
    writePid(777);
    let probeCount = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === "SIGTERM") throw new Error("already gone");
      if (signal === 0 || signal === undefined) {
        probeCount += 1;
        if (probeCount === 1) return true;
        const err = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    const engine = makeEngineStub();
    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("PID 777 was already gone (already gone)");
      expect(result.output).toContain("stopped PID 777");
      expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
    } finally {
      engine.stop(true);
    }
  });
});

describe("token use extra coverage", () => {
  test("buildEnvrcContent strips current, direct, team, and legacy token exports", () => {
    const existing = [
      "KEEP_ME=1",
      "export CLAUDE_TOKEN_NAME=\"old\"",
      "CLAUDE_TOKEN_NAME=older",
      "export CLAUDE_CODE_OAUTH_TOKEN=\"$(pass show claude/token-old)\"",
      "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_PYM",
      "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0",
      "export TOKEN_PYM=\"$(pass show claude/token-pym)\"",
      "TOKEN_DO=\"$(pass show claude/token-do)\"",
      "export TOKEN_TING_TING=\"$(pass show claude/token-ting)\"",
      "",
      "",
    ].join("\n");

    const content = buildEnvrcContent(existing, "fresh", true);

    expect(content).toBe([
      "KEEP_ME=1",
      "",
      "export CLAUDE_TOKEN_NAME=\"fresh\"",
      "export CLAUDE_CODE_OAUTH_TOKEN=\"$(pass show claude/token-fresh)\"",
      "",
    ].join("\n"));
    expect(content).not.toContain("old");
    expect(content).not.toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
    expect(content).not.toContain("TOKEN_PYM");
  });

  test("cmdUse returns usage and missing-pass errors before touching .envrc", () => {
    expect(cmdUse({ name: "", cwd: tmpProject })).toEqual({
      ok: false,
      error: "usage: maw token use <name> [--no-team]",
    });

    passEntries = new Set();
    expect(cmdUse({ name: "missing", cwd: tmpProject })).toEqual({
      ok: false,
      error: "token \"missing\" not found in pass (claude/token-missing)",
    });
    expect(existsSync(join(tmpProject, ".envrc"))).toBe(false);
    expect(runCalls.map(call => call.cmd)).toEqual([["pass", "show", "claude/token-missing"]]);
  });

  test("cmdUse creates a new envrc and can skip direnv", () => {
    const result = cmdUse({ name: "demo", cwd: tmpProject, noTeam: true, skipDirenv: true });

    expect(result).toEqual({
      ok: true,
      name: "demo",
      content: [
        "export CLAUDE_TOKEN_NAME=\"demo\"",
        "export CLAUDE_CODE_OAUTH_TOKEN=\"$(pass show claude/token-demo)\"",
        "",
      ].join("\n"),
      direnvOk: true,
    });
    expect(readFileSync(join(tmpProject, ".envrc"), "utf-8")).toBe(result.content);
    expect(runCalls.map(call => call.cmd)).toEqual([["pass", "show", "claude/token-demo"]]);
  });

  test("cmdUse rewrites existing envrc and reports direnv allow failure", () => {
    writeFileSync(join(tmpProject, ".envrc"), "KEEP=1\nexport CLAUDE_TOKEN_NAME=\"old\"\n\n", "utf-8");
    direnvOk = false;

    const result = cmdUse({ name: "fresh", cwd: tmpProject });

    expect(result.ok).toBe(true);
    expect(result.name).toBe("fresh");
    expect(result.direnvOk).toBe(false);
    expect(result.content).toBe([
      "KEEP=1",
      "",
      "export CLAUDE_TOKEN_NAME=\"fresh\"",
      "export CLAUDE_CODE_OAUTH_TOKEN=\"$(pass show claude/token-fresh)\"",
      "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
      "",
    ].join("\n"));
    expect(readFileSync(join(tmpProject, ".envrc"), "utf-8")).toBe(result.content);
    expect(runCalls.map(call => call.cmd)).toEqual([
      ["pass", "show", "claude/token-fresh"],
      ["direnv", "allow", "."],
    ]);
    expect(runCalls[1]?.opts?.cwd).toBe(tmpProject);
  });
});
