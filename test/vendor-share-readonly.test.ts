import { beforeEach, describe, expect, test } from "bun:test";

import { attach } from "../src/vendor/mpr-plugins/share/stream";
import type { Share } from "../src/vendor/mpr-plugins/share/impl";

type WsMessage = string | Uint8Array;
type FakeWs = {
  send: (data: WsMessage) => void;
};

function makeFakeWs(): { ws: FakeWs; sent: Array<WsMessage> } {
  const sent: Array<WsMessage> = [];
  return {
    ws: {
      send: (data: WsMessage) => sent.push(data),
    },
    sent,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("share readonly stream", () => {
  let killCalls: Array<Array<unknown>> = [];
  let pipeCalls: Array<Array<unknown>> = [];
  let captures: string[] = [];
  let sendKeysCalls: number = 0;

  beforeEach(() => {
    killCalls = [];
    pipeCalls = [];
    captures = [];
    sendKeysCalls = 0;
  });

  test("dropping inbound ws messages does not write pane text", async () => {
    const share: Share = {
      target: "session:0",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 1_000_000,
      auth: "token",
    };

    const { ws, sent } = makeFakeWs();
    let childResolve: (() => void) | null = null;
    const handle = await attach(
      share,
      ws as unknown as any,
      {
        tmux: {
          capture: async (target: string) => {
            captures.push(target);
            return "SNAPSHOT\n";
          },
          pipePane: async (...args: unknown[]) => {
            pipeCalls.push(args);
          },
          sendKeys: async () => {
            sendKeysCalls += 1;
          },
        },
        spawnTail: async (_path: string, onChunk: (chunk: Uint8Array) => void) => {
          onChunk(bytes("LIVE\n"));
          return {
            kill: (signal?: string | number) => {
              killCalls.push(["kill", signal]);
            },
            exited: new Promise((resolve) => {
              childResolve = resolve;
            }),
          };
        },
      } as any,
    );

    expect(sent).toEqual(["SNAPSHOT\n", bytes("LIVE\n")] );
    expect(captures).toEqual(["session:0"]);

    handle.onMessage("ping");
    handle.onMessage(bytes("typed-inbound"));
    handle.onMessage("typed-string");
    expect(sendKeysCalls).toBe(0);

    await handle.close();
    if (childResolve) childResolve();

    expect(pipeCalls.some((call) => call[0] === "session:0" && call.length === 1)).toBe(true);
    expect(killCalls.length).toBeGreaterThan(0);
  });
});
