import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChild from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpHome = "";
let spawnMode: "throw" | "success" = "success";
let spawnPid: number | null = 56789;
let onSpawn: (() => void) | undefined;
let spawnCalls: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];

const saved = {
  home: process.env.MAW_HOME,
  state: process.env.MAW_STATE_DIR,
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
    if (spawnMode === "throw") throw new Error("spawn exploded");
    onSpawn?.();
    return {
      pid: spawnPid,
      unref: () => undefined,
    } as any;
  },
}));

const { default: messagesHandler } = await import("../../src/vendor/mpr-plugins/messages/index.ts?vendor-messages-third-pass-coverage");

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

function engineStub(options: { initialRegistration?: boolean } = {}) {
  let registrations: Array<Record<string, unknown>> = options.initialRegistration
    ? [{ plugin: "messages", prefix: "/api/message-ledger", upstream: "http://127.0.0.1:1" }]
    : [];
  let unregisterCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
        return Response.json({ ok: true, registrations });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        unregisterCalls += 1;
        registrations = [];
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    setRegistered(upstream = "http://127.0.0.1:4321") {
      registrations = [{ plugin: "messages", prefix: "/api/message-ledger", upstream }];
    },
    unregisterCalls: () => unregisterCalls,
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-vendor-messages-third-"));
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_STATE_DIR;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  process.argv = [...saved.argv];
  process.kill = saved.kill;
  Date.now = saved.dateNow;
  Bun.sleep = saved.bunSleep;
  spawnMode = "success";
  spawnPid = 56789;
  onSpawn = undefined;
  spawnCalls = [];
});

afterEach(() => {
  restoreEnv("MAW_HOME", saved.home);
  restoreEnv("MAW_STATE_DIR", saved.state);
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

describe("vendor messages third pass coverage", () => {
  test("detach short-circuits when a live supervisor is already registered", async () => {
    const engine = engineStub({ initialRegistration: true });
    writePid(13579);
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(13579);
      if (signal === 0 || signal === undefined) return true;
      throw new Error("should not stop an already registered supervisor");
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve already running (PID 13579, /api/message-ledger registered)");
      expect(spawnCalls).toHaveLength(0);
    } finally {
      engine.stop();
    }
  });

  test("detach removes pid files when terminating a live unregistered supervisor throws", async () => {
    const engine = engineStub();
    writePid(24680);
    spawnPid = null;
    let sigtermFailed = false;
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(24680);
      if (signal === 0 || signal === undefined) {
        if (!sigtermFailed) return true;
        const err = new Error("gone after sigterm failure") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      if (signal === "SIGTERM") {
        sigtermFailed = true;
        throw new Error("already gone during sigterm");
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
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
      expect(spawnCalls).toHaveLength(1);
    } finally {
      engine.stop();
    }
  });

  test("detach reports a live unregistered supervisor that does not exit", async () => {
    const engine = engineStub();
    writePid(97531);
    fastPollingClock();
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(97531);
      if (signal === 0 || signal === undefined) return true;
      if (signal === "SIGTERM") return true;
      return true;
    }) as typeof process.kill;

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("maw messages serve has a live PID 97531 but /api/message-ledger is not registered");
      expect(result.error).toContain(`run: maw messages stop --engine ${engine.url}`);
      expect(spawnCalls).toHaveLength(0);
    } finally {
      engine.stop();
    }
  });

  test("detach reports spawn exceptions and does not leave a pid file", async () => {
    const engine = engineStub();
    spawnMode = "throw";

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url, "--port", "0"],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("failed to spawn maw messages serve: spawn exploded");
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toMatchObject({
        command: process.argv[0],
        args: [process.argv[1], "messages", "serve", "--engine", engine.url, "--port", "0"],
      });
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
    } finally {
      engine.stop();
    }
  });

  test("detach success can stream status lines through a writer", async () => {
    const engine = engineStub();
    onSpawn = () => engine.setRegistered();
    const written: string[] = [];

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url],
        writer: (line: string) => { written.push(line); },
      });

      expect(result.ok).toBe(true);
      expect(result.output).toBe("");
      expect(written).toEqual([
        "maw messages serve detached (PID 56789)",
        `registered: /api/message-ledger on ${engine.url}`,
        `log: ${supervisorFile("messages.log")}`,
      ]);
      expect(existsSync(supervisorFile("messages.pid"))).toBe(true);
    } finally {
      engine.stop();
    }
  });

  test("detach supervisor files follow MAW_STATE_DIR when MAW_HOME is absent", async () => {
    const engine = engineStub();
    const stateDir = mkdtempSync(join(tmpdir(), "maw-vendor-messages-state-"));
    delete process.env.MAW_HOME;
    process.env.MAW_STATE_DIR = stateDir;
    fastPollingClock();
    onSpawn = () => engine.setRegistered();

    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["serve", "--detach", "--engine", engine.url],
      });

      const statePid = join(stateDir, "engine-plugins", "messages.pid");
      const stateLog = join(stateDir, "engine-plugins", "messages.log");
      expect(result.ok).toBe(true);
      expect(result.output).toContain(`log: ${stateLog}`);
      expect(existsSync(statePid)).toBe(true);
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
    } finally {
      engine.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("stop without a pid exits cleanly when the engine is already unregistered", async () => {
    const engine = engineStub();

    try {
      const result = await messagesHandler({ source: "cli", args: ["stop", "--engine", engine.url] });

      expect(result.ok).toBe(true);
      expect(result.output).toBe("maw messages serve already stopped");
      expect(engine.unregisterCalls()).toBe(0);
    } finally {
      engine.stop();
    }
  });
});
