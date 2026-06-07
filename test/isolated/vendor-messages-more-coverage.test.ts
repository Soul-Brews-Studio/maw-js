import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChild from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildMessageLifecycleFeedEvent } from "../../src/lib/message-events";
import { messageLedgerDbPath } from "../../src/vendor/mpr-plugins/messages/ledger";

let tmpHome = "";
const savedHome = process.env.MAW_HOME;
const savedConfig = process.env.MAW_CONFIG_DIR;
const savedEngineUrl = process.env.MAW_ENGINE_URL;
const savedMawPort = process.env.MAW_PORT;
const savedMessagesPort = process.env.MAW_MESSAGES_PORT;
const savedKill = process.kill;
const savedArgv = [...process.argv];
const savedFetch = global.fetch;

let spawnPid: number | null = 43210;
let spawnCalls: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];

mock.module("child_process", () => ({
  ...realChild,
  spawn: (command: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    spawnCalls.push({ command, args, env: opts.env });
    return {
      pid: spawnPid,
      unref: () => {},
    } as any;
  },
}));

const { default: messagesHandler, messagesEngineFetch, onEvent } = await import("../../src/vendor/mpr-plugins/messages/index");

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function supervisorPath(file: string) {
  return join(tmpHome, "engine-plugins", file);
}

function writePid(pid: number | string) {
  mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
  writeFileSync(supervisorPath("messages.pid"), `${pid}\n`, "utf-8");
}

function engineStub(options: {
  registrations?: Array<Record<string, unknown>>;
  registrationsStatus?: number;
  unregisterKeepsRegistration?: boolean;
  onRegister?: (body: Record<string, unknown>) => void;
} = {}) {
  let registrations = [...(options.registrations ?? [])];
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
        if (options.registrationsStatus && options.registrationsStatus >= 400) {
          return new Response("registrations unavailable", { status: options.registrationsStatus });
        }
        return Response.json({ ok: true, registrations });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/register") {
        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        registrations = [body as Record<string, unknown>];
        options.onRegister?.(body as Record<string, unknown>);
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        if (!options.unregisterKeepsRegistration) registrations = [];
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-vendor-messages-more-"));
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  process.argv = [...savedArgv];
  process.kill = savedKill;
  global.fetch = savedFetch;
  spawnPid = 43210;
  spawnCalls = [];
});

afterEach(() => {
  restoreEnv("MAW_HOME", savedHome);
  restoreEnv("MAW_CONFIG_DIR", savedConfig);
  restoreEnv("MAW_ENGINE_URL", savedEngineUrl);
  restoreEnv("MAW_PORT", savedMawPort);
  restoreEnv("MAW_MESSAGES_PORT", savedMessagesPort);
  process.argv = [...savedArgv];
  process.kill = savedKill;
  global.fetch = savedFetch;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("vendor messages more isolated coverage", () => {
  test("api calls with array args ignore cli flags but still force json output", async () => {
    const result = await messagesHandler({ source: "api", args: ["--limit", "1", "--json"] as any });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output!)).toEqual({
      ok: true,
      messages: [],
      total: 0,
      dbPath: messageLedgerDbPath(),
    });
  });

  test("text output truncates long message fields and collapses whitespace", async () => {
    await onEvent(buildMessageLifecycleFeedEvent({
      id: "long-row",
      ts: "2026-05-18T01:02:03.000Z",
      direction: "outbound",
      state: "failed",
      channel: "hey",
      route: "peer",
      from: "m5:sender",
      to: "m5:receiver",
      text: `first\n${"x".repeat(120)}`,
      error: `err-${"y".repeat(120)}`,
      lastLine: `last-${"z".repeat(120)}`,
      signed: false,
    }));

    const result = await messagesHandler({ source: "cli", args: [] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("2026-05-18 01:02:03Z  ✗ outbound/peer/failed");
    expect(result.output).toContain("first ");
    expect(result.output).toContain("…");
    expect(result.output).not.toContain("\nxxxxxxxx");
  });

  test("status tolerates malformed pid files and unavailable registration endpoint", async () => {
    writePid("not-a-number");
    const engine = engineStub({ registrationsStatus: 503 });

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["status", "--engine", `http://127.0.0.1:${engine.port}`],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve: stopped");
      expect(result.output).toContain("registered: no");
      expect(result.output).not.toContain("stale pid file present");
    } finally {
      engine.stop(true);
    }
  });

  test("detach cleans up a live unregistered pid before spawning a fresh supervisor", async () => {
    writePid(24680);
    let probeCount = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === "SIGTERM") return true;
      if (signal === 0 || signal === undefined) {
        probeCount += 1;
        if (probeCount === 1) return true;
        const err = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    let registeredBody: Record<string, unknown> | undefined;
    const engine = engineStub({
      onRegister(body) {
        registeredBody = body;
      },
    });

    try {
      const resultPromise = messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
      });
      setTimeout(() => {
        void fetch(`http://127.0.0.1:${engine.port}/api/_engine/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plugin: "messages", prefix: "/api/message-ledger", upstream: "http://127.0.0.1:0" }),
        }).catch(() => {});
      }, 25);

      const result = await resultPromise;
      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve detached (PID 43210)");
      expect(existsSync(supervisorPath("messages.pid"))).toBe(true);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toMatchObject({
        command: process.argv[0],
        args: [process.argv[1], "messages", "serve", "--engine", `http://127.0.0.1:${engine.port}`],
      });
      expect(spawnCalls[0]?.env?.MAW_ENGINE_URL).toBe(`http://127.0.0.1:${engine.port}`);
      expect(registeredBody).toMatchObject({ plugin: "messages", prefix: "/api/message-ledger" });
    } finally {
      engine.stop(true);
    }
  });

  test("engine queries accept valid URL filters and reject unsupported paths by method", async () => {
    await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildMessageLifecycleFeedEvent({
        id: "url-filtered",
        ts: "2026-05-18T04:00:00.000Z",
        direction: "inbound",
        state: "delivered",
        channel: "api-send",
        route: "team",
        from: "node/a",
        to: "node/b",
        text: "filter target text",
      })),
    }));

    const filtered = await messagesEngineFetch(new Request("http://plugin.local/messages?limit=1&from=node/a&to=node/b&direction=inbound&state=delivered&q=target"));
    expect(await filtered.json()).toMatchObject({ ok: true, total: 1, messages: [{ id: "url-filtered" }] });

    const wrongMethod = await messagesEngineFetch(new Request("http://plugin.local/messages", { method: "POST" }));
    expect(wrongMethod.status).toBe(404);
    expect(await wrongMethod.json()).toEqual({ ok: false, error: "not_found" });
  });
});
