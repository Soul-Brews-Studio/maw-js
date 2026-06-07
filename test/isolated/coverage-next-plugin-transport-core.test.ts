import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { LoRaTransport } from "../../src/transports/lora";
import {
  classifyError,
  TransportRouter,
  type Transport,
  type TransportMessage,
  type TransportPresence,
} from "../../src/core/transport/transport";
import { createSshTransport, HostExecError } from "../../src/core/transport/ssh";

const srcRoot = join(import.meta.dir, "../..");

let hookCalls: Array<{ event: string; ctx: Record<string, string> }> = [];
let hookError: Error | null = null;

mock.module(join(srcRoot, "src/hooks"), () => ({
  runHook: async (event: string, ctx: Record<string, string>) => {
    hookCalls.push({ event, ctx });
    if (hookError) throw hookError;
  },
}));
mock.module(join(srcRoot, "src/hooks.ts"), () => ({
  runHook: async (event: string, ctx: Record<string, string>) => {
    hookCalls.push({ event, ctx });
    if (hookError) throw hookError;
  },
}));
mock.module("../../hooks", () => ({
  runHook: async (event: string, ctx: Record<string, string>) => {
    hookCalls.push({ event, ctx });
    if (hookError) throw hookError;
  },
}));

const shellHooks = (await import("../../src/plugins/builtin/shell-hooks.ts?coverage-next-plugin-transport-core")).default;

const originalError = console.error;
const originalRequire = (globalThis as any).require;

beforeEach(() => {
  hookCalls = [];
  hookError = null;
});

afterEach(() => {
  console.error = originalError;
  if (originalRequire === undefined) delete (globalThis as any).require;
  else (globalThis as any).require = originalRequire;
});

function makeTransport(name: string, options: {
  connected?: boolean;
  reachable?: boolean;
  send?: () => boolean | Promise<boolean>;
  fail?: unknown;
  peers?: () => unknown[];
} = {}) {
  const handlers = {
    message: [] as Array<(msg: TransportMessage) => void>,
    presence: [] as Array<(presence: TransportPresence) => void>,
    feed: [] as Array<(event: any) => void>,
  };
  const calls: string[] = [];
  const transport = {
    name,
    connected: options.connected ?? true,
    async connect() { calls.push("connect"); },
    async disconnect() { calls.push("disconnect"); },
    async send() {
      calls.push("send");
      if (options.fail) throw options.fail;
      return options.send ? await options.send() : true;
    },
    async publishPresence() { calls.push("presence"); },
    async publishFeed() { calls.push("feed"); },
    onMessage(handler: (msg: TransportMessage) => void) { handlers.message.push(handler); },
    onPresence(handler: (presence: TransportPresence) => void) { handlers.presence.push(handler); },
    onFeed(handler: (event: any) => void) { handlers.feed.push(handler); },
    canReach() { return options.reachable ?? true; },
    listPeers: options.peers,
    handlers,
    calls,
  } satisfies Transport & {
    handlers: typeof handlers;
    calls: string[];
    listPeers?: () => unknown[];
  };
  return transport;
}

describe("coverage-next plugin transport core", () => {
  test("shell hook bridge forwards feed fields and logs rejected hook promises", async () => {
    let listener: ((event: { event: string; oracle: string; message: string }) => void) | null = null;
    const errors: string[] = [];
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
    (globalThis as any).require = (id: string) => {
      if (id === "../../hooks") {
        return {
          runHook: async (event: string, ctx: Record<string, string>) => {
            hookCalls.push({ event, ctx });
            if (hookError) throw hookError;
          },
        };
      }
      return originalRequire(id);
    };

    shellHooks({
      on(name: string, handler: typeof listener) {
        expect(name).toBe("*");
        listener = handler;
      },
    } as any);

    expect(listener).toBeFunction();
    listener!({ event: "Stop", oracle: "lyra", message: "done" });
    await Promise.resolve();
    expect(hookCalls).toEqual([{
      event: "Stop",
      ctx: { from: "lyra", to: "lyra", message: "done", channel: "feed" },
    }]);

    hookError = new Error("hook boom");
    listener!({ event: "Error", oracle: "lyra", message: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.join("\n")).toContain("[hooks] Error hook boom");
  });

  test("LoRa stub exposes a safe disconnected transport surface", async () => {
    const lora = new LoRaTransport();

    expect(lora.name).toBe("lora");
    expect(lora.connected).toBe(false);
    await lora.connect();
    expect(lora.connected).toBe(false);
    expect(await lora.send({ oracle: "lyra" }, "hello")).toBe(false);
    await lora.publishPresence({ oracle: "lyra", host: "local", status: "idle", timestamp: 1 });
    await lora.publishFeed({ oracle: "lyra", host: "local", event: "Stop", timestamp: "now", ts: 1 } as any);
    lora.onMessage(() => undefined);
    lora.onPresence(() => undefined);
    lora.onFeed(() => undefined);
    expect(lora.canReach({ oracle: "lyra" })).toBe(false);
    await lora.disconnect();
    expect(lora.connected).toBe(false);
  });

  test("TransportRouter wires handlers, failover, broadcasts, status, and peer listing", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
    try {
      const first = makeTransport("first", { send: () => false, peers: () => [{ name: "peer-a" }] });
      const second = makeTransport("second", { fail: new Error("ETIMEDOUT") });
      const third = makeTransport("third");
      const brokenPeer = makeTransport("broken-peer", {
        reachable: false,
        peers: () => { throw new Error("scan failed"); },
      });

      const router = new TransportRouter();
      router.register(first);
      router.register(second);
      router.register(third);
      router.register(brokenPeer);

      const messages: TransportMessage[] = [];
      const presences: TransportPresence[] = [];
      const feeds: any[] = [];
      router.onMessage((msg) => messages.push(msg));
      router.onPresence((presence) => presences.push(presence));
      router.onFeed((event) => feeds.push(event));

      first.handlers.message[0]!({ from: "a", to: "b", body: "hi", timestamp: 1, transport: "tmux" });
      first.handlers.presence[0]!({ oracle: "a", host: "h", status: "ready", timestamp: 2 });
      first.handlers.feed[0]!({ event: "Stop" });
      expect(messages).toHaveLength(1);
      expect(presences).toHaveLength(1);
      expect(feeds).toHaveLength(1);

      await router.connectAll();
      expect(first.calls).toContain("connect");
      expect(second.calls).toContain("connect");

      await expect(router.send({ oracle: "b" }, "hello", "a")).resolves.toEqual({
        ok: true,
        via: "third",
        retryable: false,
      });
      expect(logs.join("\n")).toContain("send failed for b");
      expect(logs.join("\n")).toContain("timeout (retryable)");

      const authOnly = new TransportRouter();
      authOnly.register(makeTransport("auth", { fail: new Error("403 forbidden") }));
      await expect(authOnly.send({ oracle: "b" }, "hello", "a")).resolves.toEqual({
        ok: false,
        via: "auth",
        reason: "auth",
        retryable: false,
      });

      await router.publishPresence({ oracle: "a", host: "h", status: "ready", timestamp: 3 });
      await router.publishFeed({ oracle: "a", host: "h", event: "Stop", timestamp: "now", ts: 4 } as any);
      expect(first.calls).toContain("presence");
      expect(third.calls).toContain("feed");
      expect(router.status()).toContainEqual({ name: "first", connected: true });
      expect(router.listDiscoveredPeers()).toEqual([{ name: "peer-a" }]);

      await router.disconnectAll();
      expect(third.calls).toContain("disconnect");
      expect(classifyError(new Error("bad json"))).toEqual({ reason: "parse_error", retryable: false });
    } finally {
      console.log = originalLog;
    }
  });

  test("ssh transport sendKeys covers special keys, slash commands, enter-only, text, and host errors", async () => {
    const calls: string[] = [];
    const fakeTmux = {
      listSessions: async () => [],
      capture: async () => "",
      selectWindow: async () => undefined,
      getPaneCommand: async () => "",
      getPaneCommands: async () => ({}),
      getPaneInfos: async () => ({}),
      exitModeIfNeeded: async (target: string) => { calls.push(`exit:${target}`); },
      sendKeys: async (target: string, key: string) => { calls.push(`key:${target}:${key}`); },
      sendKeysLiteral: async (target: string, ch: string) => { calls.push(`lit:${target}:${ch}`); },
      sendText: async (target: string, text: string) => { calls.push(`text:${target}:${text}`); },
    };
    const spawned: string[][] = [];
    const transport = createSshTransport({
      env: () => ({ MAW_HOST: "remote.example" } as any),
      loadConfig: () => ({ host: "remote.example", commands: { custom: "custom-agent --flag" } } as any),
      requireConfig: () => ({ loadConfig: () => ({ commands: { custom: "custom-agent --flag" } }) as any }),
      createTmux: () => fakeTmux as any,
      tmuxCmd: () => "tmux",
      spawn: ((args: string[]) => {
        spawned.push(args);
        const fail = args.includes("remote.example");
        return {
          stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("ok\n")); controller.close(); } }),
          stderr: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(fail ? "no route\n" : "")); controller.close(); } }),
          exited: Promise.resolve(fail ? 7 : 0),
        };
      }) as any,
    });

    await transport.sendKeys("s:1", "\x1b[A");
    await transport.sendKeys("s:1", "\n");
    await transport.sendKeys("s:1", "/status\n");
    await transport.sendKeys("s:1", "hello\n");

    expect(calls).toContain("key:s:1:Up");
    expect(calls).toContain("exit:s:1");
    expect(calls).toContain("key:s:1:Enter");
    expect(calls).toContain("lit:s:1:/");
    expect(calls).toContain("lit:s:1:s");
    expect(calls).toContain("text:s:1:hello");
    expect(transport.isAgentCommand("custom-agent")).toBe(true);
    expect(transport.isAgentCommand("custom-agent-helper")).toBe(false);
    expect(await transport.hostExec("echo ok", "localhost")).toBe("ok");
    await expect(transport.hostExec("echo nope")).rejects.toBeInstanceOf(HostExecError);
    expect(spawned[0]).toEqual(["bash", "-c", "echo ok"]);
    expect(spawned[1]).toEqual(["ssh", "remote.example", "echo nope"]);
  });
});
