import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../src/lib/feed";
import type { Session } from "../src/core/runtime/find-window";
import { TmuxTransport } from "../src/transports/tmux";

function sampleSessions(): Session[] {
  return [
    {
      name: "47-mawjs",
      windows: [
        { index: 0, name: "mawjs-oracle", active: true },
        { index: 1, name: "mawjs-codex", active: false },
      ],
    },
  ];
}

describe("TmuxTransport", () => {
  test("tracks local tmux lifecycle", async () => {
    const transport = new TmuxTransport();

    expect(transport.name).toBe("tmux");
    expect(transport.connected).toBe(false);

    await transport.connect();
    expect(transport.connected).toBe(true);

    await transport.disconnect();
    expect(transport.connected).toBe(false);
  });

  test("can only reach local targets", () => {
    const transport = new TmuxTransport();

    expect(transport.canReach({ oracle: "mawjs" })).toBe(true);
    expect(transport.canReach({ oracle: "mawjs", host: "local" })).toBe(true);
    expect(transport.canReach({ oracle: "mawjs", host: "localhost" })).toBe(true);
    expect(transport.canReach({ oracle: "mawjs", host: "m5" })).toBe(false);
  });

  test("uses explicit tmux target without scanning sessions", async () => {
    const sends: Array<{ target: string; message: string }> = [];
    let scanned = false;
    const transport = new TmuxTransport(
      async (target, message) => { sends.push({ target, message }); },
      async () => {
        scanned = true;
        return sampleSessions();
      },
    );

    expect(await transport.send({ oracle: "ignored", tmuxTarget: "47-mawjs:1" }, "hello")).toBe(true);
    expect(scanned).toBe(false);
    expect(sends).toEqual([{ target: "47-mawjs:1", message: "hello" }]);
  });

  test("resolves a local oracle through tmux session scan", async () => {
    const sends: Array<{ target: string; message: string }> = [];
    const scanned: Session[][] = [];
    const queries: string[] = [];
    const transport = new TmuxTransport(
      async (target, message) => { sends.push({ target, message }); },
      async () => {
        const sessions = sampleSessions();
        scanned.push(sessions);
        return sessions;
      },
      (sessions, query) => {
        queries.push(query);
        expect(sessions).toBe(scanned[0]);
        return "47-mawjs:1";
      },
    );

    expect(await transport.send({ oracle: "mawjs-codex" }, "ping")).toBe(true);
    expect(queries).toEqual(["mawjs-codex"]);
    expect(sends).toEqual([{ target: "47-mawjs:1", message: "ping" }]);
  });

  test("returns false for remote, unresolved, and throwing send paths", async () => {
    let sendCalls = 0;
    const remote = new TmuxTransport(
      async () => { sendCalls += 1; },
      async () => sampleSessions(),
    );
    expect(await remote.send({ oracle: "mawjs", host: "remote" }, "nope")).toBe(false);
    expect(sendCalls).toBe(0);

    const unresolved = new TmuxTransport(
      async () => { sendCalls += 1; },
      async () => sampleSessions(),
      () => null,
    );
    expect(await unresolved.send({ oracle: "missing" }, "nope")).toBe(false);

    const throwing = new TmuxTransport(
      async () => { throw new Error("tmux rejected"); },
      async () => sampleSessions(),
      () => "47-mawjs:1",
    );
    expect(await throwing.send({ oracle: "mawjs" }, "nope")).toBe(false);
    expect(sendCalls).toBe(0);
  });

  test("accepts handlers and ignores publish-only hooks", async () => {
    const transport = new TmuxTransport();

    transport.onMessage(() => {});
    transport.onPresence(() => {});
    transport.onFeed(() => {});

    await expect(transport.publishPresence({
      oracle: "mawjs",
      host: "m5",
      status: "ready",
      timestamp: 1,
    })).resolves.toBeUndefined();

    const event: FeedEvent = {
      timestamp: "2026-05-17 00:00:00",
      oracle: "mawjs",
      host: "m5",
      event: "MessageSend",
      project: "maw-js",
      sessionId: "test",
      message: "hello",
      ts: 1,
    };
    await expect(transport.publishFeed(event)).resolves.toBeUndefined();
  });
});
