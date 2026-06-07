import { beforeEach, describe, expect, mock, test } from "bun:test";

let fakeConfig: Record<string, unknown> = {};
const curlCalls: Array<{ url: string; opts: Record<string, unknown> | undefined }> = [];
let curlResult: unknown = { ok: true, data: { ok: true } };
let curlThrow: Error | null = null;

mock.module(import.meta.resolve("../../src/config.ts"), () => ({
  loadConfig: () => fakeConfig,
}));

mock.module(import.meta.resolve("../../src/core/transport/curl-fetch.ts"), () => ({
  curlFetch: async (url: string, opts?: Record<string, unknown>) => {
    curlCalls.push({ url, opts });
    if (curlThrow) throw curlThrow;
    return curlResult;
  },
}));

const { resolveNanoclawJid, sendViaNanoclaw } = await import(
  "../../src/bridges/nanoclaw.ts?nanoclaw-bridge-more-coverage"
);

beforeEach(() => {
  fakeConfig = {};
  curlCalls.length = 0;
  curlResult = { ok: true, data: { ok: true } };
  curlThrow = null;
});

describe("nanoclaw bridge", () => {
  test("resolves direct JIDs, channel aliases, bare aliases, and misses", () => {
    fakeConfig = {
      nanoclaw: {
        url: "http://nanoclaw.local",
        channels: {
          nat: "tg:12345",
          discord: "dc:999",
        },
      },
    };

    expect(resolveNanoclawJid("tg:already")).toEqual({ jid: "tg:already", url: "http://nanoclaw.local" });
    expect(resolveNanoclawJid("discord:nat")).toEqual({ jid: "tg:12345", url: "http://nanoclaw.local" });
    expect(resolveNanoclawJid("nat")).toEqual({ jid: "tg:12345", url: "http://nanoclaw.local" });
    expect(resolveNanoclawJid("discord")).toEqual({ jid: "dc:999", url: "http://nanoclaw.local" });
    expect(resolveNanoclawJid("telegram:missing")).toBeNull();
    expect(resolveNanoclawJid("missing")).toBeNull();
  });

  test("returns null when nanoclaw config or url is absent", () => {
    expect(resolveNanoclawJid("tg:123")).toBeNull();
    fakeConfig = { nanoclaw: { channels: { nat: "tg:123" } } };
    expect(resolveNanoclawJid("nat")).toBeNull();
  });

  test("posts messages and maps ok/data failures to false", async () => {
    expect(await sendViaNanoclaw("tg:123", "hello", "http://nanoclaw.local")).toBe(true);
    expect(curlCalls).toEqual([
      {
        url: "http://nanoclaw.local/send",
        opts: { method: "POST", body: JSON.stringify({ jid: "tg:123", text: "hello" }) },
      },
    ]);

    curlResult = { ok: false, data: { ok: true } };
    expect(await sendViaNanoclaw("tg:123", "hello", "http://nanoclaw.local")).toBe(false);

    curlResult = { ok: true, data: { ok: false } };
    expect(await sendViaNanoclaw("tg:123", "hello", "http://nanoclaw.local")).toBe(false);

    curlThrow = new Error("offline");
    expect(await sendViaNanoclaw("tg:123", "hello", "http://nanoclaw.local")).toBe(false);
  });
});
