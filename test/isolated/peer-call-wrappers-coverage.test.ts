/** Targeted isolated coverage for thin re-export modules and peer-call wrappers absent from LCOV. */
import { describe, expect, mock, test } from "bun:test";

const curlFetchCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

mock.module("maw-js/sdk", () => ({
  curlFetch: async (url: string, opts: Record<string, unknown>) => {
    curlFetchCalls.push({ url, opts });
    return { ok: true, status: 200, data: { ok: true } };
  },
}));

describe("thin re-export and peer-call coverage", () => {
  test("wake and kill peer-call wrappers post signed JSON bodies", async () => {
    const wake = await import("../../src/vendor/mpr-plugins/wake/internal/peer-call");
    const kill = await import("../../src/vendor/mpr-plugins/kill/internal/peer-call");

    await expect(wake.callPeerWake("http://peer", { oracle: "neo" })).resolves.toMatchObject({ ok: true });
    await expect(kill.callPeerKill("http://peer", { target: "neo", pane: 1 })).resolves.toMatchObject({ status: 200 });

    expect(curlFetchCalls).toEqual([
      { url: "http://peer/api/wake", opts: { method: "POST", body: JSON.stringify({ oracle: "neo" }), from: "auto" } },
      { url: "http://peer/api/kill", opts: { method: "POST", body: JSON.stringify({ target: "neo", pane: 1 }), from: "auto" } },
    ]);
  });

});
