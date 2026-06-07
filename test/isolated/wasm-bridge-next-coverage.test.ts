import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

type MawSendCall = [target: string, text: string];

let sendCalls: MawSendCall[] = [];
let sendShouldReject = false;
let identityResult: unknown = { node: "test-node", agents: ["neo"] };
let federationResult: unknown = { peers: [{ name: "pulse", online: true }] };
let identityShouldReject = false;
let federationShouldReject = false;
let consoleCalls: Array<[method: string, ...args: unknown[]]> = [];
let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];

const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;
const realConsole = {
  debug: console.debug,
  log: console.log,
  warn: console.warn,
  error: console.error,
};
const realFetch = globalThis.fetch;

mock.module(join(import.meta.dir, "../../src/core/runtime/sdk"), () => ({
  maw: {
    send: async (target: string, text: string) => {
      sendCalls.push([target, text]);
      if (sendShouldReject) throw new Error("send boom");
    },
    identity: async () => {
      if (identityShouldReject) throw new Error("identity boom");
      return identityResult;
    },
    federation: async () => {
      if (federationShouldReject) throw new Error("federation boom");
      return federationResult;
    },
  },
}));

const {
  buildImportObject,
  preCacheBridge,
  textEncoder,
} = await import("../../src/cli/wasm-bridge");

function makeMemoryHarness(initialPages = 1) {
  const mem = new WebAssembly.Memory({ initial: initialPages });
  let nextPtr = 256;
  const alloc = (size: number) => {
    const ptr = nextPtr;
    nextPtr += size;
    return ptr;
  };
  const writeRaw = (value: string, ptr = nextPtr) => {
    const bytes = textEncoder.encode(value);
    new Uint8Array(mem.buffer).set(bytes, ptr);
    nextPtr = Math.max(nextPtr, ptr + bytes.length + 8);
    return { ptr, len: bytes.length };
  };
  const readPrefixed = (ptr: number) => {
    const len = new DataView(mem.buffer).getUint32(ptr, true);
    return new TextDecoder().decode(new Uint8Array(mem.buffer, ptr + 4, len));
  };
  return { mem, alloc, writeRaw, readPrefixed };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sendCalls = [];
  sendShouldReject = false;
  identityResult = { node: "test-node", agents: ["neo"] };
  federationResult = { peers: [{ name: "pulse", online: true }] };
  identityShouldReject = false;
  federationShouldReject = false;
  consoleCalls = [];
  stdoutWrites = [];
  stderrWrites = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.debug = (...args: unknown[]) => { consoleCalls.push(["debug", ...args]); };
  console.log = (...args: unknown[]) => { consoleCalls.push(["log", ...args]); };
  console.warn = (...args: unknown[]) => { consoleCalls.push(["warn", ...args]); };
  console.error = (...args: unknown[]) => { consoleCalls.push(["error", ...args]); };
  globalThis.fetch = realFetch;
});

afterEach(() => {
  process.stdout.write = realStdoutWrite;
  process.stderr.write = realStderrWrite;
  console.debug = realConsole.debug;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
  globalThis.fetch = realFetch;
});

describe("wasm-bridge next coverage", () => {
  test("routes stdout, stderr, and every log level through decoded wasm strings", () => {
    const { mem, alloc, writeRaw } = makeMemoryHarness();
    const bridge = buildImportObject(() => mem, () => alloc);

    const out = writeRaw("hello stdout");
    const err = writeRaw("hello stderr");
    const log = writeRaw("log payload");

    bridge.env.maw_print(out.ptr, out.len);
    bridge.env.maw_print_err(err.ptr, err.len);
    for (const level of [0, 1, 2, 3, 99]) {
      bridge.env.maw_log(level, log.ptr, log.len);
    }

    expect(stdoutWrites).toEqual(["hello stdout"]);
    expect(stderrWrites).toEqual(["hello stderr"]);
    expect(consoleCalls).toEqual([
      ["debug", "[wasm]", "log payload"],
      ["log", "[wasm]", "log payload"],
      ["warn", "[wasm]", "log payload"],
      ["error", "[wasm]", "log payload"],
      ["log", "[wasm]", "log payload"],
    ]);
  });

  test("preCacheBridge stores success values and unreachable fallbacks for SDK queries", async () => {
    const first = makeMemoryHarness();
    const successBridge = buildImportObject(() => first.mem, () => first.alloc);

    await preCacheBridge(successBridge);

    expect(JSON.parse(first.readPrefixed(successBridge.env.maw_identity()))).toEqual(identityResult);
    expect(JSON.parse(first.readPrefixed(successBridge.env.maw_federation()))).toEqual(federationResult);

    const second = makeMemoryHarness();
    const fallbackBridge = buildImportObject(() => second.mem, () => second.alloc);
    identityShouldReject = true;
    federationShouldReject = true;

    await preCacheBridge(fallbackBridge);

    expect(JSON.parse(second.readPrefixed(fallbackBridge.env.maw_identity()))).toEqual({ error: "unreachable" });
    expect(JSON.parse(second.readPrefixed(fallbackBridge.env.maw_federation()))).toEqual({ error: "unreachable" });
  });

  test("maw_federation returns default error JSON before being cached", () => {
    const { mem, alloc, readPrefixed } = makeMemoryHarness();
    const bridge = buildImportObject(() => mem, () => alloc);

    expect(JSON.parse(readPrefixed(bridge.env.maw_federation()))).toEqual({
      error: "federation not pre-cached",
    });

    bridge._setCachedFederation('{"ok":true}');
    expect(JSON.parse(readPrefixed(bridge.env.maw_federation()))).toEqual({ ok: true });
  });

  test("maw_send decodes target and text and logs rejected fire-and-forget sends", async () => {
    const { mem, alloc, writeRaw } = makeMemoryHarness();
    const bridge = buildImportObject(() => mem, () => alloc);

    const target = writeRaw("pulse");
    const message = writeRaw("hello");
    expect(bridge.env.maw_send(target.ptr, target.len, message.ptr, message.len)).toBe(1);
    await flushAsyncWork();
    expect(sendCalls).toEqual([["pulse", "hello"]]);

    sendShouldReject = true;
    const badTarget = writeRaw("ghost");
    const badMessage = writeRaw("boom");
    expect(bridge.env.maw_send(badTarget.ptr, badTarget.len, badMessage.ptr, badMessage.len)).toBe(1);
    await flushAsyncWork();

    expect(sendCalls.at(-1)).toEqual(["ghost", "boom"]);
    expect(consoleCalls).toContainEqual(["error", "[wasm] maw_send to ghost failed:", "send boom"]);
  });

  test("maw_fetch stashes success and failure payloads until maw_async_result consumes them", async () => {
    const { mem, alloc, writeRaw, readPrefixed } = makeMemoryHarness();
    const bridge = buildImportObject(() => mem, () => alloc);

    globalThis.fetch = (async (url: RequestInfo | URL) => ({
      text: async () => `body:${String(url)}`,
    })) as typeof fetch;

    const url = writeRaw("https://example.invalid/success");
    const id = bridge.env.maw_fetch(url.ptr, url.len);
    await flushAsyncWork();

    const successPtr = bridge.env.maw_async_result(id);
    expect(readPrefixed(successPtr)).toBe("body:https://example.invalid/success");
    expect(bridge.env.maw_async_result(id)).toBe(0);

    globalThis.fetch = (async () => {
      throw new Error("fetch boom");
    }) as typeof fetch;

    const badUrl = writeRaw("https://example.invalid/fail");
    const badId = bridge.env.maw_fetch(badUrl.ptr, badUrl.len);
    await flushAsyncWork();

    expect(JSON.parse(readPrefixed(bridge.env.maw_async_result(badId)))).toEqual({
      error: "fetch boom",
    });
  });

  test("maw_alloc with zero bytes returns the current page offset without growing memory", () => {
    const { mem, alloc } = makeMemoryHarness();
    const bridge = buildImportObject(() => mem, () => alloc);
    const before = mem.buffer.byteLength;

    expect(bridge.env.maw_alloc(0)).toBe(before);
    expect(mem.buffer.byteLength).toBe(before);
  });
});
