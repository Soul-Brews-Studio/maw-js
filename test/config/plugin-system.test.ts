/**
 * Tests for PluginSystem from src/plugins/10_system.ts.
 * No mocking needed — PluginSystem is self-contained.
 */
import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { PluginSystem } from "../../src/plugins/10_system";
import type { FeedEvent } from "../../src/lib/feed";

function makeEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    timestamp: new Date().toISOString(),
    oracle: "neo",
    host: "local",
    event: "Notification",
    project: "test",
    sessionId: "",
    message: "test",
    ts: Date.now(),
    ...overrides,
  };
}

let sys: PluginSystem;

beforeEach(() => {
  sys = new PluginSystem();
});

describe("PluginSystem", () => {
  describe("emit", () => {
    it("returns true when no plugins loaded", async () => {
      expect(await sys.emit(makeEvent())).toBe(true);
    });

    it("calls handler on matching event", async () => {
      let called = false;
      sys.load((hooks) => {
        hooks.on("Notification", () => { called = true; });
      });
      await sys.emit(makeEvent({ event: "Notification" }));
      expect(called).toBe(true);
    });

    it("does not call handler on non-matching event", async () => {
      let called = false;
      sys.load((hooks) => {
        hooks.on("SessionStart", () => { called = true; });
      });
      await sys.emit(makeEvent({ event: "Notification" }));
      expect(called).toBe(false);
    });

    it("wildcard * matches all events", async () => {
      const events: string[] = [];
      sys.load((hooks) => {
        hooks.on("*", (e) => { events.push(e.event); });
      });
      await sys.emit(makeEvent({ event: "Notification" }));
      await sys.emit(makeEvent({ event: "SessionStart" }));
      expect(events).toEqual(["Notification", "SessionStart"]);
    });
  });

  describe("gate", () => {
    it("blocks event when gate returns false", async () => {
      let handled = false;
      sys.load((hooks) => {
        hooks.gate("Notification", () => false);
        hooks.on("Notification", () => { handled = true; });
      });
      const result = await sys.emit(makeEvent());
      expect(result).toBe(false);
      expect(handled).toBe(false);
    });

    it("allows event when gate returns true", async () => {
      let handled = false;
      sys.load((hooks) => {
        hooks.gate("Notification", () => true);
        hooks.on("Notification", () => { handled = true; });
      });
      await sys.emit(makeEvent());
      expect(handled).toBe(true);
    });
  });

  describe("filter", () => {
    it("transforms event for downstream handlers", async () => {
      let received = "";
      sys.load((hooks) => {
        hooks.filter("Notification", (e) => ({ ...e, message: "filtered!" }));
        hooks.on("Notification", (e) => { received = e.message; });
      });
      await sys.emit(makeEvent({ message: "original" }));
      expect(received).toBe("filtered!");
    });

    it("continues chain when filter throws", async () => {
      const spy = spyOn(console, "error").mockImplementation(() => {});
      let handled = false;
      sys.load((hooks) => {
        hooks.filter("Notification", () => { throw new Error("bad filter"); });
        hooks.on("Notification", () => { handled = true; });
      });
      await sys.emit(makeEvent());
      expect(handled).toBe(true);
      spy.mockRestore();
    });
  });

  describe("late", () => {
    it("runs after handlers", async () => {
      const order: string[] = [];
      sys.load((hooks) => {
        hooks.on("Notification", () => { order.push("handle"); });
        hooks.late("Notification", () => { order.push("late"); });
      });
      await sys.emit(makeEvent());
      expect(order).toEqual(["handle", "late"]);
    });
  });

  describe("load", () => {
    it("captures teardown function", () => {
      let tornDown = false;
      sys.load(() => () => { tornDown = true; });
      sys.destroy();
      expect(tornDown).toBe(true);
    });

    it("handles plugin that returns void", () => {
      sys.load(() => {}); // should not throw
    });
  });

  describe("register + stats", () => {
    it("tracks registered plugins in stats", () => {
      sys.register("test-plugin", "ts", "user");
      const stats = sys.stats();
      expect(stats.plugins).toHaveLength(1);
      expect(stats.plugins[0].name).toBe("test-plugin");
    });

    it("counts total events", async () => {
      await sys.emit(makeEvent());
      await sys.emit(makeEvent());
      expect(sys.stats().totalEvents).toBe(2);
    });

    it("counts gated events", async () => {
      sys.load((hooks) => {
        hooks.gate("Notification", () => false);
      });
      await sys.emit(makeEvent());
      expect(sys.stats().gated).toBe(1);
    });

    it("counts errors", async () => {
      const spy = spyOn(console, "error").mockImplementation(() => {});
      sys.load((hooks) => {
        hooks.on("Notification", () => { throw new Error("boom"); });
      }, "user", "bad-plugin");
      sys.register("bad-plugin", "ts", "user");
      await sys.emit(makeEvent());
      expect(sys.stats().totalErrors).toBe(1);
      spy.mockRestore();
    });
  });

  describe("unloadScope", () => {
    it("removes user plugins but keeps builtin", async () => {
      let builtinCalled = false;
      let userCalled = false;
      sys.load((hooks) => {
        hooks.on("Notification", () => { builtinCalled = true; });
      }, "builtin");
      sys.load((hooks) => {
        hooks.on("Notification", () => { userCalled = true; });
      }, "user");

      sys.unloadScope("user");
      await sys.emit(makeEvent());

      expect(builtinCalled).toBe(true);
      expect(userCalled).toBe(false);
    });

    it("calls teardown for unloaded scope", () => {
      let tornDown = false;
      sys.load(() => () => { tornDown = true; }, "user");
      sys.unloadScope("user");
      expect(tornDown).toBe(true);
    });
  });

  describe("destroy", () => {
    it("calls all teardowns", () => {
      let count = 0;
      sys.load(() => () => { count++; }, "builtin");
      sys.load(() => () => { count++; }, "user");
      sys.destroy();
      expect(count).toBe(2);
    });
  });

  describe("pipeline order", () => {
    it("executes gate → filter → handle → late", async () => {
      const order: string[] = [];
      sys.load((hooks) => {
        hooks.gate("Notification", () => { order.push("gate"); return true; });
        hooks.filter("Notification", (e) => { order.push("filter"); return e; });
        hooks.on("Notification", () => { order.push("handle"); });
        hooks.late("Notification", () => { order.push("late"); });
      });
      await sys.emit(makeEvent());
      expect(order).toEqual(["gate", "filter", "handle", "late"]);
    });
  });
});
