import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  acquirePidLock,
  pidFile,
  printServeStatusWithPlugins,
  serveStatus,
  stopServe,
} from "../../src/cli/instance-pid";

let tempHome = "";
const origHome = process.env.MAW_HOME;
const origEngineUrl = process.env.MAW_ENGINE_URL;
const origExit = process.exit;
const origKill = process.kill;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "maw-pid-"));
  process.env.MAW_HOME = tempHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = origHome;
  if (origEngineUrl === undefined) delete process.env.MAW_ENGINE_URL;
  else process.env.MAW_ENGINE_URL = origEngineUrl;
  process.exit = origExit;
  process.kill = origKill;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("maw serve PID lock UX (#1434)", () => {
  test("stale PID files are removed and replaced", () => {
    writeFileSync(pidFile(), "99999999");

    acquirePidLock(null);

    expect(readFileSync(pidFile(), "utf-8")).toBe(String(process.pid));
  });

  test("live PID failure prints actionable status/stop/force hints", () => {
    writeFileSync(pidFile(), String(process.pid));
    const err: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { err.push(args.join(" ")); };
    process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as never;

    try {
      expect(() => acquirePidLock("dev")).toThrow("exit:1");
    } finally {
      console.error = origErr;
    }

    const text = err.join("\n");
    expect(text).toContain("maw serve already running as dev");
    expect(text).toContain("maw serve stop");
    expect(text).toContain("maw serve status");
    expect(text).toContain("maw serve --force-takeover");
  });

  test("serve status cleans stale PID files", () => {
    writeFileSync(pidFile(), "99999999");

    expect(serveStatus()).toEqual({ pid: 99999999, alive: false, file: pidFile() });
    expect(serveStatus()).toEqual({ pid: null, alive: false, file: pidFile() });
  });

  test("force takeover kills prior process and acquires the lock", () => {
    writeFileSync(pidFile(), "4242");
    const kills: Array<{ pid: number; signal?: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    acquirePidLock(null, { forceTakeover: true });

    expect(kills).toEqual([
      { pid: 4242, signal: 0 },
      { pid: 4242, signal: "SIGTERM" },
    ]);
    expect(readFileSync(pidFile(), "utf-8")).toBe(String(process.pid));
  });

  test("serve stop terminates live PID and removes the lock", () => {
    writeFileSync(pidFile(), "4242");
    const kills: Array<{ pid: number; signal?: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    stopServe();

    expect(kills).toEqual([
      { pid: 4242, signal: 0 },
      { pid: 4242, signal: "SIGTERM" },
    ]);
    expect(serveStatus()).toEqual({ pid: null, alive: false, file: pidFile() });
  });

  test("serve status includes registered engine plugins when the gateway is reachable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/_engine/registrations") {
          return Response.json({
            ok: true,
            registrations: [{
              plugin: "messages",
              prefix: "/api/message-ledger",
              upstream: "unix:///tmp/maw-messages.sock",
              health: "/health",
              events: ["MessageSend"],
            }],
          });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    });
    const lines: string[] = [];
    const origLog = console.log;
    writeFileSync(pidFile(), String(process.pid));
    process.env.MAW_ENGINE_URL = `http://127.0.0.1:${server.port}`;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };

    try {
      await printServeStatusWithPlugins();
    } finally {
      console.log = origLog;
      server.stop(true);
    }

    const text = lines.join("\n");
    expect(text).toContain("maw serve: running");
    expect(text).toContain("engine plugins");
    expect(text).toContain("messages: /api/message-ledger");
    expect(text).toContain("events=MessageSend");
  });
});
