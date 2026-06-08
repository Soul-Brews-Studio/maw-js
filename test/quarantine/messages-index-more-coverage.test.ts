import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as realChild from "child_process";
import { buildMessageLifecycleFeedEvent } from "../../src/lib/message-events";

let tmpHome = "";
const savedHome = process.env.MAW_HOME;
const savedEngineUrl = process.env.MAW_ENGINE_URL;
const savedPort = process.env.MAW_PORT;
const savedMessagesPort = process.env.MAW_MESSAGES_PORT;
const savedArgv = [...process.argv];
const savedKill = process.kill;

let spawnPid: number | null = 43210;
let spawnArgs: string[] | undefined;
let spawnedCommand: string | undefined;

mock.module("child_process", () => ({
  ...realChild,
  spawn: (command: string, args: string[]) => {
    spawnedCommand = command;
    spawnArgs = args;
    return {
      pid: spawnPid,
      unref: () => {},
    } as any;
  },
}));

const { default: messagesHandler, installServeShutdown, messagesEngineFetch, onEvent } = await import("../../src/vendor/mpr-plugins/messages/index");

function resetEnv() {
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  process.argv = [...savedArgv];
  process.kill = savedKill;
  spawnPid = 43210;
  spawnArgs = undefined;
  spawnedCommand = undefined;
}

function makeEngineStub(options: {
  registrations?: Array<Record<string, unknown>>;
  unregisterStatus?: number;
  onUnregister?: () => void;
}) {
  let registrations = [...(options.registrations ?? [])];
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
        return Response.json({ ok: true, registrations });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/register") {
        registrations = [await req.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>];
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        registrations = [];
        options.onUnregister?.();
        return Response.json({ ok: true }, { status: options.unregisterStatus ?? 200 });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-messages-more-"));
  resetEnv();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = savedHome;
  if (savedEngineUrl === undefined) delete process.env.MAW_ENGINE_URL;
  else process.env.MAW_ENGINE_URL = savedEngineUrl;
  if (savedPort === undefined) delete process.env.MAW_PORT;
  else process.env.MAW_PORT = savedPort;
  if (savedMessagesPort === undefined) delete process.env.MAW_MESSAGES_PORT;
  else process.env.MAW_MESSAGES_PORT = savedMessagesPort;
  process.argv = [...savedArgv];
  process.kill = savedKill;
  rmSync(tmpHome, { force: true, recursive: true });
});

describe("messages plugin additional coverage", () => {
  test("writer mode receives empty-ledger output without accumulating logs", async () => {
    const lines: string[] = [];

    const result = await messagesHandler({
      source: "cli",
      args: [],
      writer: (line: string) => lines.push(line),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("");
    expect(lines).toEqual([expect.stringContaining("no messages recorded")]);
  });

  test("api args ignore array payloads and string false json flag", async () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "api-array-ignored",
      ts: "2026-05-18T01:00:00.000Z",
      direction: "outbound",
      state: "queued",
      channel: "api",
      route: "local",
      from: "node/source",
      to: "node/dest",
      text: "array args should not filter this row",
      signed: false,
    });
    await onEvent({ ...event, event: "MessageSend" });

    const result = await messagesHandler({
      source: "api",
      args: ["--from", "different/node"],
    });

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.output!);
    expect(payload.total).toBe(1);
    expect(payload.messages[0].id).toBe("api-array-ignored");
  });

  test("engine fetch records valid lifecycle events and applies url filters", async () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "fetch-recorded",
      ts: "2026-05-18T02:00:00.000Z",
      direction: "forwarded",
      state: "failed",
      channel: "hey",
      route: "relay",
      from: "node/a",
      to: "node/b",
      text: "needle from fetch endpoint",
      error: "boom",
      signed: true,
    });

    const recorded = await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }));
    expect(await recorded.json()).toEqual({ ok: true, recorded: true });

    const filtered = await messagesEngineFetch(new Request("http://plugin.local/messages?limit=1&from=node/a&to=node/b&direction=forwarded&state=failed&q=needle"));
    const body = await filtered.json();
    expect(body.total).toBe(1);
    expect(body.messages[0].id).toBe("fetch-recorded");
  });

  test("serve --detach includes tail log when child never registers", async () => {
    process.argv = ["/usr/bin/bun", "/opt/maw/dist/maw"];
    const engine = makeEngineStub({ registrations: [] });
    mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
    writeFileSync(join(tmpHome, "engine-plugins", "messages.log"), `${"x".repeat(1300)}\nlast useful log line\n`, "utf-8");

    const engineUrl = `http://127.0.0.1:${engine.port}`;
    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", engineUrl, "--port", "0"],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not register /api/message-ledger");
    expect(result.error).toContain("tail:\n");
    expect(result.error).toContain("last useful log line");
    expect(spawnedCommand).toBe("/usr/bin/bun");
    expect(spawnArgs).toEqual(["/opt/maw/dist/maw", "messages", "serve", "--engine", engineUrl, "--port", "0"]);
  });

  test("stop handles no pid and forces unregister when registration remains", async () => {
    let unregisterCalls = 0;
    const engine = makeEngineStub({
      registrations: [{ plugin: "messages", prefix: "/api/message-ledger", upstream: "http://127.0.0.1:0" }],
      onUnregister() {
        unregisterCalls += 1;
      },
    });

    const result = await messagesHandler({
      source: "cli",
      args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw messages serve already stopped");
    expect(result.output).toContain("forced unregister /api/message-ledger");
    expect(unregisterCalls).toBe(1);
  });

  test("shutdown hook uses default process dependencies once", async () => {
    const callbacks: Record<string, () => void> = {};
    const stops: boolean[] = [];
    const exits: number[] = [];
    const originalOnce = process.once;
    const originalExit = process.exit;
    const originalFetch = global.fetch;

    process.once = ((event: string, callback: () => void) => {
      callbacks[event] = callback;
      return process;
    }) as typeof process.once;
    process.exit = ((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;
    global.fetch = (async () => new Response("ignored", { status: 503 })) as typeof fetch;

    try {
      const shutdown = installServeShutdown("http://engine.local", { stop: (force?: boolean) => stops.push(Boolean(force)) }, {
        timeoutMs: 5,
        warn: (() => {}) as typeof console.warn,
      });
      expect(Object.keys(callbacks).sort()).toEqual(["SIGINT", "SIGTERM"]);
      await callbacks.SIGINT();
      await shutdown();
    } finally {
      process.once = originalOnce;
      process.exit = originalExit;
      global.fetch = originalFetch;
    }

    expect(stops).toEqual([true]);
    expect(exits).toEqual([0]);
  });
});
