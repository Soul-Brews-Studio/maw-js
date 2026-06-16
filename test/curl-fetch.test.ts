import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test", FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json", MAW_ROOT: "/tmp",
  resolveHome: () => "/tmp/maw-test",
}));

let mockToken: string | undefined = "test-token-16chars!";
let mockConfigThrows = false;
const savedTransport = process.env.MAW_CURL_FETCH_TRANSPORT;
const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
const realWarn = console.warn;
const realError = console.error;

import { mockConfigModule } from "./helpers/mock-config";
mock.module("../src/config", () => mockConfigModule(() => {
  if (mockConfigThrows) throw new Error("simulated config load failure");
  return { federationToken: mockToken, node: "test" };
}));

const { curlFetch } = await import("../src/core/transport/curl-fetch");

function setFetch(fn: typeof fetch) {
  globalThis.fetch = fn;
}

beforeEach(() => {
  mockToken = "test-token-16chars!";
  mockConfigThrows = false;
  process.env.MAW_CURL_FETCH_TRANSPORT = "native";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (Bun as any).spawn = realSpawn;
  console.warn = realWarn;
  console.error = realError;
  if (savedTransport === undefined) delete process.env.MAW_CURL_FETCH_TRANSPORT;
  else process.env.MAW_CURL_FETCH_TRANSPORT = savedTransport;
});

describe("curlFetch native transport", () => {
  test("uses mocked native fetch for deterministic success", async () => {
    setFetch(async () => Response.json({ transport: "native" }));
    const res = await curlFetch("http://example.invalid/native", { timeout: 1000 });
    expect(res).toEqual({ ok: true, status: 200, data: { transport: "native" } });
  });
  test("returns ok:false for mocked network failures", async () => {
    setFetch(async () => { throw new Error("connect timeout"); });
    const res = await curlFetch("http://example.invalid/api/test", { timeout: 1000 });
    expect(res).toMatchObject({ ok: false, status: 0, data: null });
  });
  test("warns on nativeFetch failure with method + URL (#385 site 1)", async () => {
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    setFetch(async () => { throw new Error("connect timeout"); });
    const res = await curlFetch("http://example.invalid/api/test", {
      method: "POST",
      body: JSON.stringify({ t: 1 }),
      timeout: 1000,
    });
    expect(res).toMatchObject({ ok: false, status: 0, data: null });
    expect(logs.join("\n")).toMatch(/nativeFetch failed.*POST.*example\.invalid/);
  });
  test("fails closed when signing throws — does not send unsigned request (#385 site 5)", async () => {
    const logs: string[] = [];
    let fetched = false;
    mockConfigThrows = true;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    setFetch(async () => { fetched = true; return Response.json({ shouldNot: "send" }); });
    const res = await curlFetch("http://example.invalid/api/send", {
      method: "POST",
      body: JSON.stringify({ t: 1 }),
      timeout: 1000,
    });
    expect(res).toMatchObject({ ok: false, status: 0, data: null });
    expect(fetched).toBe(false);
    expect(logs.some((l) => /signing/i.test(l))).toBe(true);
  });
});

describe("curlFetch body size cap (#653)", () => {
  test("rejects body exceeding maxBytes while streaming", async () => {
    setFetch(async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { n++ < 20 ? controller.enqueue(chunk) : controller.close(); },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });
    const res = await curlFetch("http://example.invalid/huge", { maxBytes: 1024 * 1024, timeout: 5000 });

    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded/);
  });
  test("rejects when Content-Length exceeds cap before buffering", async () => {
    setFetch(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(50 * 1024 * 1024) },
    }));
    const res = await curlFetch("http://example.invalid/declared", { maxBytes: 1024, timeout: 5000 });

    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded 1024 bytes/);
  });
  test("passes through when body is under cap", async () => {
    setFetch(async () => Response.json({ hello: "world" }));
    const res = await curlFetch("http://example.invalid/small", { maxBytes: 1024, timeout: 5000 });
    expect(res).toEqual({ ok: true, status: 200, data: { hello: "world" } });
  });
  test("default cap is 10 MB when maxBytes is not supplied", async () => {
    setFetch(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(11 * 1024 * 1024) },
    }));
    const res = await curlFetch("http://example.invalid/default", { timeout: 5000 });

    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded 10485760 bytes/);
  });
});

describe("curlFetch curl subprocess transport", () => {
  beforeEach(() => {
    mockToken = undefined;
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";
  });
  test("parses successful curl stdout and passes method, body, and limits", async () => {
    const calls: unknown[][] = [];
    (Bun as any).spawn = (args: string[]) => {
      calls.push(args);
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true })));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };
    const res = await curlFetch("http://example.invalid/api", {
      method: "POST",
      body: JSON.stringify({ hello: "curl" }),
      timeout: 2500,
      maxBytes: 2048,
    });
    expect(res).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--max-time");
    expect(calls[0]).toContain("3");
    expect(calls[0]).toContain("--max-filesize");
    expect(calls[0]).toContain("2048");
    expect(calls[0]).toContain("POST");
    expect(calls[0]).toContain(JSON.stringify({ hello: "curl" }));
  });
  test("kills curl when streamed stdout exceeds maxBytes", async () => {
    let killed = false;
    (Bun as any).spawn = () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(0),
      kill: () => { killed = true; },
    });
    const res = await curlFetch("http://example.invalid/huge", { maxBytes: 10, timeout: 1000 });

    expect(res.ok).toBe(false);
    expect(res.data?.error).toMatch(/body exceeded 10 bytes/);
    expect(killed).toBe(true);
  });
});
