import { describe, test, expect } from "bun:test";
import { PluginSystem, loadPlugins } from "../src/plugins";
import type { FeedEvent } from "../src/lib/feed";

const mockEvent: FeedEvent = {
  timestamp: "2026-04-10 16:00",
  oracle: "neo",
  host: "white.local",
  event: "SessionStart",
  project: "/home/test",
  sessionId: "abc123",
  message: "Session started",
  ts: Date.now(),
};

describe("PluginSystem", () => {
  test("plugin receives events via hooks.on", async () => {
    const sys = new PluginSystem();
    const received: FeedEvent[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e));
    });

    await sys.emit(mockEvent);
    expect(received).toHaveLength(1);
    expect(received[0].oracle).toBe("neo");
  });

  test("wildcard * receives all events", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.on("*", (e) => received.push(e.event));
    });

    await sys.emit(mockEvent);
    await sys.emit({ ...mockEvent, event: "Notification" });
    expect(received).toEqual(["SessionStart", "Notification"]);
  });

  test("named hook only fires for matching event", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.on("SessionEnd", (e) => received.push(e.event));
    });

    await sys.emit(mockEvent); // SessionStart — should NOT fire
    expect(received).toHaveLength(0);
  });

  test("multiple plugins on same hook", async () => {
    const sys = new PluginSystem();
    const order: number[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => order.push(1));
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", () => order.push(2));
    });

    await sys.emit(mockEvent);
    expect(order).toEqual([1, 2]);
  });

  test("error in one plugin does not crash others", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => { throw new Error("boom"); });
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["neo"]);
  });

  test("teardown function called on destroy", () => {
    const sys = new PluginSystem();
    let tornDown = false;

    sys.load(() => {
      return () => { tornDown = true; };
    });

    expect(tornDown).toBe(false);
    sys.destroy();
    expect(tornDown).toBe(true);
  });

  test("loadPlugins skips non-plugin wasm files", async () => {
    const sys = new PluginSystem();
    // ~/.oracle/plugins/ has demo.wasm (add/mul) — should skip gracefully
    await loadPlugins(sys, require("path").join(require("os").homedir(), ".oracle", "plugins"));
    // Should not throw, demo.wasm has no handle or _start
  });

  test("loadPlugins handles missing directory", async () => {
    const sys = new PluginSystem();
    await loadPlugins(sys, "/nonexistent/path");
    // Should not throw
  });
});
