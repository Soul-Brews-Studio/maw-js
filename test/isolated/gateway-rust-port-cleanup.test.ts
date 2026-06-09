import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: string[] = [];

class FakeStream extends EventEmitter {
  off(eventName: string, listener: (...args: unknown[]) => void) {
    return super.off(eventName, listener);
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

mock.module("node:child_process", () => ({
  execSync: (cmd: string, opts: unknown) => {
    calls.push(`exec:${cmd}:${JSON.stringify(opts)}`);
  },
  spawn: (cmd: string, args: string[], opts: unknown) => {
    calls.push(`spawn:${cmd}:${JSON.stringify(args)}:${JSON.stringify(opts)}`);
    const child = new FakeChild();
    queueMicrotask(() => child.stdout.emit("data", Buffer.from(`listening on :4788\n`)));
    return child;
  },
}));

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
      const child = await selectGateway({ cliGateway: "rust" }).start(4788) as FakeChild;

      expect(calls[0]).toContain("exec:lsof -ti :4788 | xargs kill");
      expect(calls[0]).toContain('{"stdio":"ignore"}');
      expect(calls[1]).toContain(`spawn:${binary}:["serve","--port","4788"]`);

      child.kill();
    } finally {
      if (previous === undefined) delete process.env.MAW_GATEWAY_BIN;
      else process.env.MAW_GATEWAY_BIN = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
