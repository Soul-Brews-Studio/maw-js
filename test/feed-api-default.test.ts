import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createFeedApi,
  defaultFeedApiDeps,
  feedBuffer,
  feedListeners,
  pushFeedEvent,
  pushFeedEventWithDeps,
  type FeedApiDeps,
} from "../src/api/feed";
import type { FeedEvent } from "../src/lib/feed";

const NOW = Date.parse("2026-05-17T00:00:00.000Z");

async function json(res: Response): Promise<any> {
  return await res.json();
}

function event(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    timestamp: "2026-05-17T00:00:00.000Z",
    oracle: "mawjs",
    host: "m5",
    event: "MessageSend",
    project: "maw-js",
    sessionId: "s1",
    message: "hello",
    ts: NOW,
    ...overrides,
  };
}

function deps(overrides: Partial<FeedApiDeps> = {}): FeedApiDeps {
  return {
    feedBuffer: [],
    feedListeners: new Set(),
    cfgLimit: ((name: string) => {
      if (name === "feedMax") return 2;
      if (name === "feedDefault") return 2;
      return 100;
    }) as any,
    markRealFeedEvent: (() => undefined) as any,
    now: () => NOW,
    isoNow: () => "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

function appWith(d: FeedApiDeps) {
  return new Elysia({ prefix: "/api" }).use(createFeedApi(d));
}

describe("feed API default-suite coverage", () => {
  test("pushFeedEventWithDeps truncates to feedMax and notifies listeners", () => {
    const seen: FeedEvent[] = [];
    const d = deps();
    d.feedListeners.add((e) => seen.push(e));

    pushFeedEventWithDeps(event({ oracle: "old", ts: NOW - 3 }), d);
    pushFeedEventWithDeps(event({ oracle: "mid", ts: NOW - 2 }), d);
    pushFeedEventWithDeps(event({ oracle: "new", ts: NOW - 1 }), d);

    expect(d.feedBuffer.map((e) => e.oracle)).toEqual(["mid", "new"]);
    expect(seen.map((e) => e.oracle)).toEqual(["old", "mid", "new"]);
  });

  test("pushFeedEvent uses the exported default buffer/listeners", () => {
    const previousBuffer = feedBuffer.splice(0);
    const previousListeners = [...feedListeners];
    feedListeners.clear();
    const seen: FeedEvent[] = [];
    feedListeners.add((e) => seen.push(e));
    try {
      const row = event({ oracle: "default-buffer" });
      pushFeedEvent(row);
      expect(feedBuffer.at(-1)).toEqual(row);
      expect(seen).toEqual([row]);
    } finally {
      feedBuffer.splice(0, feedBuffer.length, ...previousBuffer);
      feedListeners.clear();
      for (const listener of previousListeners) feedListeners.add(listener);
    }
  });

  test("default feed dependency clock helpers are callable", () => {
    expect(Number.isNaN(defaultFeedApiDeps.now())).toBe(false);
    expect(Number.isNaN(Date.parse(defaultFeedApiDeps.isoNow()))).toBe(false);
  });

  test("GET /api/feed returns newest first, filters by oracle, caps limit, and lists active oracles", async () => {
    const d = deps({
      feedBuffer: [
        event({ oracle: "old", ts: NOW - 10 * 60_000, message: "old" }),
        event({ oracle: "mawjs", ts: NOW - 1_000, message: "one" }),
        event({ oracle: "mawjs", ts: NOW - 2_000, message: "two" }),
        event({ oracle: "issuer", ts: NOW - 3_000, message: "three" }),
      ],
    });
    const app = appWith(d);

    const res = await app.handle(new Request("http://local/api/feed?limit=999&oracle=mawjs"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(2);
    expect(body.events.map((e: FeedEvent) => e.message)).toEqual(["two", "one"]);
    expect(body.active_oracles).toEqual(["mawjs", "issuer"]);
  });

  test("GET /api/feed uses feedDefault when limit is omitted", async () => {
    const d = deps({
      feedBuffer: [
        event({ oracle: "one", ts: NOW - 3 }),
        event({ oracle: "two", ts: NOW - 2 }),
        event({ oracle: "three", ts: NOW - 1 }),
      ],
    });
    const app = appWith(d);

    const res = await app.handle(new Request("http://local/api/feed"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(2);
    expect(body.events.map((e: FeedEvent) => e.oracle)).toEqual(["three", "two"]);
  });

  test("POST /api/feed fills defaults, stores data, and marks worktree aliases", async () => {
    const marked: string[] = [];
    const d = deps({
      markRealFeedEvent: ((oracle: string) => marked.push(oracle)) as any,
    });
    const app = appWith(d);

    const res = await app.handle(new Request("http://local/api/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oracle: "mawjs",
        project: "maw-js.wt-7-codex-headless",
        event: "MessageDeliver",
        message: "delivered",
        data: { route: "tmux" },
      }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(d.feedBuffer).toEqual([{
      timestamp: "2026-05-17T00:00:00.000Z",
      oracle: "mawjs",
      host: "local",
      event: "MessageDeliver",
      project: "maw-js.wt-7-codex-headless",
      sessionId: "",
      message: "delivered",
      ts: NOW,
      data: { route: "tmux" },
    }]);
    expect(marked).toEqual(["mawjs", "mawjs-codex-headless"]);
  });

  test("POST /api/feed accepts an empty body shape with notification defaults", async () => {
    const marked: string[] = [];
    const d = deps({
      markRealFeedEvent: ((oracle: string) => marked.push(oracle)) as any,
    });
    const app = appWith(d);

    const res = await app.handle(new Request("http://local/api/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(d.feedBuffer[0]).toEqual({
      timestamp: "2026-05-17T00:00:00.000Z",
      oracle: "unknown",
      host: "local",
      event: "Notification",
      project: "",
      sessionId: "",
      message: "",
      ts: NOW,
    });
    expect(marked).toEqual(["unknown"]);
  });
});
