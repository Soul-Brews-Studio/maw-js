import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: string[] = [];
const realChildProcess = await import("node:child_process");

class FakeStream extends EventEmitter {
  off(eventName: string, listener: (...args: unknown[]) => void) {
    return super.off(eventName, listener);
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  kill(signal: NodeJS.Signals | string = "SIGTERM") {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string, opts: unknown) => {
    calls.push(`exec:${cmd}:${JSON.stringify(opts)}`);
  },
  spawn: (cmd: string, args: string[], opts: unknown) => {
    calls.push(`spawn:${cmd}:${JSON.stringify(args)}:${JSON.stringify(opts)}`);
    const child = new FakeChild();
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? args[portIndex + 1] : "unknown";
    queueMicrotask(() => child.stdout.emit("data", Buffer.from(`listening on :${port}\n`)));
    return child;
  },
}));

mock.module("../../src/core/server", () => ({
  startBunGatewayServer: async (port: number, options: unknown) => {
    calls.push(`bun:${port}:${JSON.stringify(options)}`);
    return {
      stop: (closeActiveConnections?: boolean) => calls.push(`bun-stop:${closeActiveConnections}`),
    };
  },
}));

afterAll(() => {
  mock.restore();
});

const { selectGateway } = await import("../../src/core/gateway.ts?gateway-rust-port-cleanup");

describe("RustGateway port cleanup", () => {
  test("runs lsof kill cleanup before spawning maw-gateway", async () => {
    calls.length = 0;
    const tmp = mkdtempSync(join(tmpdir(), "maw-gateway-cleanup-"));
    const binary = join(tmp, "maw-gateway");
    const previous = process.env.MAW_GATEWAY_BIN;
    writeFileSync(binary, "#!/bin/sh\n");
    chmodSync(binary, 0o755);
    process.env.MAW_GATEWAY_BIN = binary;
    try {
      const child = await selectGateway({ cliGateway: "rust" }).start(4788, { verbosity: 4 }) as FakeChild;

      expect(calls[0]).toContain("exec:lsof -ti :4788 | xargs kill");
      expect(calls[0]).toContain('{"stdio":"ignore"}');
      expect(calls[1]).toContain("exec:lsof -ti :4789 | xargs kill");
      expect(calls).toContain('bun:4789:{"verbosity":4,"gateway":"bun"}');
      const spawnCall = calls.find(call => call.startsWith(`spawn:${binary}:`));
      expect(spawnCall).toContain('["serve","--port","4788","--backend","4789","--verbose","4"]');
      expect(spawnCall).toContain('"PORT":"4788"');
      expect(spawnCall).toContain('"MAW_BACKEND_PORT":"4789"');
      expect(spawnCall).not.toContain("ANTHROPIC_API_KEY");
      expect(spawnCall).not.toContain("GITHUB_TOKEN");

      child.kill();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toContain("bun-stop:true");
    } finally {
      if (previous === undefined) delete process.env.MAW_GATEWAY_BIN;
      else process.env.MAW_GATEWAY_BIN = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("maw serve --gateway rust starts Rust on :3456 and Bun backend on :3457", async () => {
    calls.length = 0;
    const tmp = mkdtempSync(join(tmpdir(), "maw-gateway-dual-"));
    const binary = join(tmp, "maw-gateway");
    const previous = process.env.MAW_GATEWAY_BIN;
    writeFileSync(binary, "#!/bin/sh\n");
    chmodSync(binary, 0o755);
    process.env.MAW_GATEWAY_BIN = binary;
    try {
      const child = await selectGateway({ cliGateway: "rust" }).start(3456) as FakeChild;

      expect(calls[0]).toContain("exec:lsof -ti :3456 | xargs kill");
      expect(calls[1]).toContain("exec:lsof -ti :3457 | xargs kill");
      expect(calls).toContain('bun:3457:{"gateway":"bun"}');
      const spawnCall = calls.find(call => call.startsWith(`spawn:${binary}:`));
      expect(spawnCall).toContain('["serve","--port","3456","--backend","3457"]');

      child.kill("SIGKILL");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toContain("bun-stop:true");
    } finally {
      if (previous === undefined) delete process.env.MAW_GATEWAY_BIN;
      else process.env.MAW_GATEWAY_BIN = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
