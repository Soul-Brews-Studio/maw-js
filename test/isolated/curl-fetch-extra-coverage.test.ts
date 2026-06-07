/**
 * curl-fetch-extra-coverage.test.ts — isolated subprocess/native branch coverage
 *
 * Covers the remaining high-value branches in src/core/transport/curl-fetch.ts:
 *   - curl subprocess argv/header shaping
 *   - token-only vs v3-only vs auto-skip signing
 *   - curl nonzero exit / oversize body / invalid JSON paths
 *   - native no-reader path and native JSON-parse warning path
 *
 * Isolated because:
 *   - mock.module() for src/config is process-global
 *   - Bun.spawn is monkey-patched to avoid real curl subprocesses
 *   - globalThis.fetch is swapped for native-path seams
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import type { MawConfig } from "../../src/config";
import { mockConfigModule } from "../helpers/mock-config";

const origPeerKey = process.env.MAW_PEER_KEY;
const origCurlFetchTransport = process.env.MAW_CURL_FETCH_TRANSPORT;
process.env.MAW_PEER_KEY = "ab".repeat(32);

let configStore: Partial<MawConfig> = {};

mock.module(join(import.meta.dir, "../../src/config"), () =>
  mockConfigModule(() => configStore),
);

const { curlFetch } = await import("../../src/core/transport/curl-fetch");

const realSpawn = Bun.spawn;
const realFetch = globalThis.fetch;

type SpawnProc = ReturnType<typeof Bun.spawn>;
type SpawnHandler = (args: string[]) => SpawnProc;

let spawnHandler: SpawnHandler = () => {
  throw new Error("unexpected Bun.spawn");
};

(Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
  ((args: string[]) => spawnHandler(args)) as typeof Bun.spawn;

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function textStream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encode(part));
      controller.close();
    },
  });
}

function spawnProc(opts?: {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  onKill?: () => void;
}): SpawnProc {
  return {
    stdout: textStream(opts?.stdout ?? []),
    stderr: textStream(opts?.stderr ?? []),
    exited: Promise.resolve(opts?.exitCode ?? 0),
    kill: () => opts?.onKill?.(),
  } as unknown as SpawnProc;
}

function headerArgs(args: string[]): string[] {
  const headers: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-H") headers.push(String(args[i + 1] ?? ""));
  }
  return headers;
}

beforeEach(() => {
  configStore = {};
  spawnHandler = () => {
    throw new Error("unexpected Bun.spawn");
  };
  globalThis.fetch = realFetch;
  delete process.env.MAW_CURL_FETCH_TRANSPORT;
});

afterEach(() => {
  configStore = {};
  spawnHandler = () => {
    throw new Error("unexpected Bun.spawn");
  };
  globalThis.fetch = realFetch;
  if (origCurlFetchTransport === undefined) delete process.env.MAW_CURL_FETCH_TRANSPORT;
  else process.env.MAW_CURL_FETCH_TRANSPORT = origCurlFetchTransport;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = realSpawn;
  if (origPeerKey === undefined) delete process.env.MAW_PEER_KEY;
  else process.env.MAW_PEER_KEY = origPeerKey;
  if (origCurlFetchTransport === undefined) delete process.env.MAW_CURL_FETCH_TRANSPORT;
  else process.env.MAW_CURL_FETCH_TRANSPORT = origCurlFetchTransport;
});

describe("curlFetch extra subprocess coverage", () => {
  test("curl transport builds headers/body and parses JSON", async () => {
    configStore = {
      federationToken: "test-token-16chars!",
      oracle: "neo",
      node: "white",
    };
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";

    let seenArgs: string[] = [];
    spawnHandler = (args) => {
      seenArgs = args;
      return spawnProc({ stdout: ['{"ok":true,"transport":"curl"}'] });
    };

    const body = JSON.stringify({ text: "hi" });
    const res = await curlFetch("http://peer.invalid/api/send", {
      method: "POST",
      body,
      from: "auto",
      timeout: 1200,
    });

    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { ok: true, transport: "curl" },
    });
    expect(seenArgs[0]).toBe("curl");
    expect(seenArgs).toContain("-sf");
    expect(seenArgs).toContain("--max-time");
    expect(seenArgs).toContain("2");
    expect(seenArgs).toContain("-X");
    expect(seenArgs).toContain("POST");
    expect(seenArgs).toContain("-d");
    expect(seenArgs).toContain(body);
    expect(seenArgs.at(-1)).toBe("http://peer.invalid/api/send");

    const headers = headerArgs(seenArgs);
    expect(headers).toContain("Content-Type: application/json");
    expect(headers.some((h) => h.startsWith("X-Maw-Timestamp: "))).toBe(true);
    expect(headers.some((h) => h.startsWith("X-Maw-Signature: "))).toBe(true);
    expect(headers).toContain("X-Maw-From: neo:white");
    expect(headers.some((h) => h.startsWith("X-Maw-Signature-V3: "))).toBe(true);
    expect(headers).toContain("X-Maw-Auth-Version: v3");
  });

  test('curl transport skips v3 auto-signing when config.node is missing', async () => {
    configStore = { federationToken: "test-token-16chars!" };
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";

    let seenArgs: string[] = [];
    spawnHandler = (args) => {
      seenArgs = args;
      return spawnProc({ stdout: ["{}"] });
    };

    const res = await curlFetch("http://peer.invalid/api/send", {
      method: "POST",
      body: "{}",
      from: "auto",
    });

    expect(res.ok).toBe(true);
    const headers = headerArgs(seenArgs);
    expect(headers.some((h) => h.startsWith("X-Maw-Signature: "))).toBe(true);
    expect(headers.some((h) => h.startsWith("X-Maw-From: "))).toBe(false);
    expect(headers.some((h) => h.startsWith("X-Maw-Signature-V3: "))).toBe(false);
    expect(headers).not.toContain("X-Maw-Auth-Version: v3");
  });

  test("curl transport can emit v3-only headers when federationToken is absent", async () => {
    configStore = { oracle: "neo", node: "white" };
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";

    let seenArgs: string[] = [];
    spawnHandler = (args) => {
      seenArgs = args;
      return spawnProc({ stdout: ["{}"] });
    };

    const res = await curlFetch("http://peer.invalid/api/send", {
      method: "POST",
      body: "{}",
      from: "neo:white",
    });

    expect(res.ok).toBe(true);
    const headers = headerArgs(seenArgs);
    expect(headers.some((h) => h.startsWith("X-Maw-Signature: "))).toBe(false);
    expect(headers).toContain("X-Maw-From: neo:white");
    expect(headers.some((h) => h.startsWith("X-Maw-Signature-V3: "))).toBe(true);
    expect(headers).toContain("X-Maw-Auth-Version: v3");
  });

  test("curl transport returns subprocess exit codes", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";
    spawnHandler = () => spawnProc({ exitCode: 22 });

    const res = await curlFetch("http://peer.invalid/api/send");

    expect(res).toEqual({ ok: false, status: 22, data: null });
  });

  test("curl transport kills oversized responses and returns a cap error", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";

    let killed = false;
    spawnHandler = () => spawnProc({
      stdout: ["1234", "5"],
      exitCode: 143,
      onKill: () => { killed = true; },
    });

    const res = await curlFetch("http://peer.invalid/api/send", { maxBytes: 4 });

    expect(killed).toBe(true);
    expect(res).toEqual({
      ok: false,
      status: 0,
      data: { error: "body exceeded 4 bytes" },
    });
  });

  test("curl transport returns false when stdout is invalid JSON", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";
    spawnHandler = () => spawnProc({ stdout: ["not-json"], exitCode: 0 });

    const res = await curlFetch("http://peer.invalid/api/send");

    expect(res).toEqual({ ok: false, status: 0, data: null });
  });

  test("curlFetch fails closed when signing setup throws", async () => {
    configStore = { federationToken: "test-token-16chars!" };

    const logs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const res = await curlFetch("not a url", { method: "POST", body: "{}" });

      expect(res).toEqual({ ok: false, status: 0, data: null });
      expect(logs.join("\n")).toContain("[curl-fetch] signing failed for not a url");
    } finally {
      console.error = origError;
    }
  });
});

describe("curlFetch extra native coverage", () => {
  test("native transport returns null when the response body has no reader", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "native";
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

    const res = await curlFetch("http://peer.invalid/no-body");

    expect(res).toEqual({ ok: true, status: 204, data: null });
  });

  test("native transport rejects declared oversized responses before reading", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "native";
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, init) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Response("{}", {
        status: 200,
        headers: { "content-length": "5" },
      });
    }) as typeof fetch;

    const res = await curlFetch("http://peer.invalid/declared-too-large", { maxBytes: 4 });

    expect(res).toEqual({
      ok: false,
      status: 200,
      data: { error: "body exceeded 4 bytes" },
    });
    expect(seenSignal?.aborted).toBe(true);
  });

  test("native transport cancels streaming responses that exceed the byte cap", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "native";
    let seenSignal: AbortSignal | undefined;
    const chunks = [encode("1234"), encode("5")];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    globalThis.fetch = (async (_url, init) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Response(body, { status: 206 });
    }) as typeof fetch;

    const res = await curlFetch("http://peer.invalid/stream-too-large", { maxBytes: 4 });

    expect(seenSignal?.aborted).toBe(true);
    expect(res).toEqual({
      ok: false,
      status: 206,
      data: { error: "body exceeded 4 bytes" },
    });
  });

  test("native transport warns and returns false on invalid JSON", async () => {
    process.env.MAW_CURL_FETCH_TRANSPORT = "native";
    globalThis.fetch = (async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const logs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const res = await curlFetch("http://peer.invalid/invalid-json", {
        method: "POST",
        body: "{}",
      });

      expect(res).toEqual({ ok: false, status: 0, data: null });
      expect(logs.join("\n")).toContain("nativeFetch failed");
      expect(logs.join("\n")).toContain("http://peer.invalid/invalid-json");
    } finally {
      console.warn = origWarn;
    }
  });
});
