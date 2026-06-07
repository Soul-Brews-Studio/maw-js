import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as realChild from "child_process";

let tmpHome = "";
let spawnPid: number | null = 24601;
let spawnCalls: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];

const saved = {
  home: process.env.MAW_HOME,
  config: process.env.MAW_CONFIG_DIR,
  engineUrl: process.env.MAW_ENGINE_URL,
  mawPort: process.env.MAW_PORT,
  messagesPort: process.env.MAW_MESSAGES_PORT,
  argv: [...process.argv],
  kill: process.kill,
  dateNow: Date.now,
  bunSleep: Bun.sleep,
};

mock.module("child_process", () => ({
  ...realChild,
  spawn: (command: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
    spawnCalls.push({ command, args, env: opts.env });
    return {
      pid: spawnPid,
      unref: () => undefined,
    } as any;
  },
}));

const { default: messagesHandler } = await import("../../src/vendor/mpr-plugins/messages/index");

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function supervisorFile(name: string): string {
  return join(tmpHome, "engine-plugins", name);
}

function writePid(pid: number | string): void {
  mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
  writeFileSync(supervisorFile("messages.pid"), `${pid}\n`, "utf-8");
}

function fastPollingClock(): void {
  let now = 10_000;
  Date.now = (() => {
    now += 1_000;
    return now;
  }) as typeof Date.now;
  Bun.sleep = (async () => undefined) as typeof Bun.sleep;
}

function engineStub(options: {
  registrations?: Array<Record<string, unknown>>;
  registerStatus?: number;
  registerText?: string;
  unregisterKeepsRegistration?: boolean;
} = {}) {
  let registrations = [...(options.registrations ?? [])];
  let unregisterCalls = 0;
  const server = Bun.serve({
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
        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        registrations = [body as Record<string, unknown>];
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        unregisterCalls += 1;
        if (!options.unregisterKeepsRegistration) registrations = [];
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    unregisterCalls: () => unregisterCalls,
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-vendor-messages-second-"));
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  process.argv = [...saved.argv];
  process.kill = saved.kill;
  Date.now = saved.dateNow;
  Bun.sleep = saved.bunSleep;
  spawnPid = 24601;
  spawnCalls = [];
});

afterEach(() => {
  restoreEnv("MAW_HOME", saved.home);
  restoreEnv("MAW_CONFIG_DIR", saved.config);
  restoreEnv("MAW_ENGINE_URL", saved.engineUrl);
  restoreEnv("MAW_PORT", saved.mawPort);
  restoreEnv("MAW_MESSAGES_PORT", saved.messagesPort);
  process.argv = [...saved.argv];
  process.kill = saved.kill;
  Date.now = saved.dateNow;
  Bun.sleep = saved.bunSleep;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("vendor messages second pass coverage", () => {
  test("foreground serve returns a structured error when engine registration rejects", async () => {
    const engine = engineStub({ registerStatus: 503, registerText: "engine unavailable" });

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--engine", engine.url, "--port", "0"],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("engine register failed 503: engine unavailable");
    } finally {
      engine.stop();
    }
  });

  test("detach uses maw fallback command, removes stale pid, and reports missing child pid", async () => {
    const engine = engineStub();
    writePid(13579);
    spawnPid = null;
    process.argv = [""];
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0 || signal === undefined) {
        const err = new Error(`missing ${pid}`) as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("failed to spawn maw messages serve: no child PID");
      expect(spawnCalls).toEqual([{ command: "maw", args: ["messages", "serve", "--engine", engine.url], env: expect.any(Object) }]);
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
    } finally {
      engine.stop();
    }
  });

  test("detach reports registration timeout with child pid and supervisor log path", async () => {
    const engine = engineStub();
    fastPollingClock();
    Bun.sleep = (async () => {
      rmSync(supervisorFile("messages.log"), { force: true });
    }) as typeof Bun.sleep;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url, "--port", "0"],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("maw messages serve --detach did not register /api/message-ledger");
      expect(result.error).toContain("pid: 24601");
      expect(result.error).toContain(supervisorFile("messages.log"));
      expect(existsSync(supervisorFile("messages.pid"))).toBe(true);
      expect(spawnCalls[0]).toMatchObject({
        command: process.argv[0],
        args: [process.argv[1], "messages", "serve", "--engine", engine.url, "--port", "0"],
      });
    } finally {
      engine.stop();
    }
  });

  test("detach terminates a live unregistered pid that exits before respawning", async () => {
    const engine = engineStub();
    writePid(11223);
    spawnPid = null;
    let probes = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(11223);
      if (signal === "SIGTERM") return true;
      if (signal === 0 || signal === undefined) {
        probes += 1;
        if (probes === 1) return true;
        const err = new Error("gone after sigterm") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("no child PID");
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
      expect(spawnCalls).toHaveLength(1);
    } finally {
      engine.stop();
    }
  });

  test("stop reports a pid that stays alive after SIGTERM", async () => {
    const engine = engineStub();
    writePid(86420);
    fastPollingClock();
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(86420);
      if (signal === "SIGTERM") return true;
      if (signal === 0 || signal === undefined) return true;
      return true;
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["stop", "--engine", engine.url],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("sent SIGTERM to PID 86420");
      expect(result.error).toContain("PID 86420 did not exit after SIGTERM");
      expect(result.error).toContain(supervisorFile("messages.log"));
    } finally {
      engine.stop();
    }
  });

  test("stop records SIGTERM failures as already-gone cleanup", async () => {
    const engine = engineStub();
    writePid(97531);
    let sigtermFailed = false;
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(97531);
      if (signal === 0 || signal === undefined) {
        if (!sigtermFailed) return true;
        const err = new Error("gone after failed sigterm") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      if (signal === "SIGTERM") {
        sigtermFailed = true;
        throw new Error("permission denied");
      }
      return true;
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["stop", "--engine", engine.url],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("PID 97531 was already gone (permission denied)");
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
    } finally {
      engine.stop();
    }
  });

  test("stop removes stale pid files when no process is alive", async () => {
    const engine = engineStub();
    writePid(31415);
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(31415);
      if (signal === 0 || signal === undefined) {
        const err = new Error("stale") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["stop", "--engine", engine.url],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve already stopped");
      expect(result.output).toContain("removed stale pid file");
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
    } finally {
      engine.stop();
    }
  });

  test("stop force-unregisters when engine keeps reporting a registration", async () => {
    const engine = engineStub({
      registrations: [{ plugin: "messages", prefix: "/api/message-ledger", upstream: "http://127.0.0.1:9" }],
      unregisterKeepsRegistration: true,
    });
    fastPollingClock();

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["stop", "--engine", engine.url],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve already stopped");
      expect(result.output).toContain("forced unregister /api/message-ledger");
      expect(engine.unregisterCalls()).toBe(1);
    } finally {
      engine.stop();
    }
  });

  test("default text handler reports an empty ledger with its db path", async () => {
    const result = await messagesHandler({ source: "cli", args: [] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("no messages recorded");
    expect(result.output).toContain(join(tmpHome, "message-ledger.sqlite"));
  });
});
