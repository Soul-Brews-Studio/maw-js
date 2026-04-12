import { describe, test, expect } from "bun:test";
import { PluginSystem, loadPlugins, reloadUserPlugins } from "../src/plugins";
import type { FeedEvent } from "../src/lib/feed";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

  test("filter modifies event before handlers see it", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.filter("*", (e) => ({ ...e, message: "REDACTED" }));
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.message));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["REDACTED"]);
  });

  test("multiple filters chain in order", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.filter("*", (e) => ({ ...e, message: e.message + " [hashed]" }));
    });
    sys.load((hooks) => {
      hooks.filter("*", (e) => ({ ...e, message: e.message + " [signed]" }));
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.message));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["Session started [hashed] [signed]"]);
  });

  test("filter error does not crash handlers", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.filter("*", () => { throw new Error("filter boom"); });
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    await sys.emit(mockEvent);
    expect(received).toEqual(["neo"]);
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

  // ─── Hooks v2: Gate + Late ───

  test("gate returning false cancels the pipeline", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => false); // CANCEL
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    const result = await sys.emit(mockEvent);
    expect(result).toBe(false);
    expect(received).toHaveLength(0); // handler never ran
  });

  test("gate returning true allows pipeline to continue", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => true); // ALLOW
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    const result = await sys.emit(mockEvent);
    expect(result).toBe(true);
    expect(received).toEqual(["neo"]);
  });

  test("wildcard gate cancels all events", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("*", () => false); // CANCEL ALL
    });
    sys.load((hooks) => {
      hooks.on("*", (e) => received.push(e.event));
    });

    await sys.emit(mockEvent);
    await sys.emit({ ...mockEvent, event: "Notification" });
    expect(received).toHaveLength(0);
  });

  test("gate error does not cancel pipeline", async () => {
    const sys = new PluginSystem();
    const received: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => { throw new Error("gate boom"); });
    });
    sys.load((hooks) => {
      hooks.on("SessionStart", (e) => received.push(e.oracle));
    });

    const result = await sys.emit(mockEvent);
    expect(result).toBe(true);
    expect(received).toEqual(["neo"]);
  });

  test("late runs even when handler throws", async () => {
    const sys = new PluginSystem();
    const lateRan: boolean[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => { throw new Error("handler boom"); });
    });
    sys.load((hooks) => {
      hooks.late("SessionStart", () => { lateRan.push(true); });
    });

    await sys.emit(mockEvent);
    expect(lateRan).toHaveLength(1); // late ran despite handler error
  });

  test("late wildcard runs for all events", async () => {
    const sys = new PluginSystem();
    const lateEvents: string[] = [];

    sys.load((hooks) => {
      hooks.late("*", (e) => lateEvents.push(e.event));
    });

    await sys.emit(mockEvent);
    await sys.emit({ ...mockEvent, event: "Notification" });
    expect(lateEvents).toEqual(["SessionStart", "Notification"]);
  });

  test("full 4-phase pipeline executes in order", async () => {
    const sys = new PluginSystem();
    const order: string[] = [];

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => { order.push("gate"); return true; });
      hooks.filter("SessionStart", (e) => { order.push("filter"); return e; });
      hooks.on("SessionStart", () => { order.push("handle"); });
      hooks.late("SessionStart", () => { order.push("late"); });
    });

    await sys.emit(mockEvent);
    expect(order).toEqual(["gate", "filter", "handle", "late"]);
  });

  test("emit returns boolean (gated vs processed)", async () => {
    const sys = new PluginSystem();

    const r1 = await sys.emit(mockEvent);
    expect(r1).toBe(true); // no gates = processed

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => false);
    });

    const r2 = await sys.emit(mockEvent);
    expect(r2).toBe(false); // gated
  });

  test("stats includes gate and late counts", () => {
    const sys = new PluginSystem();

    sys.load((hooks) => {
      hooks.gate("SessionStart", () => true);
      hooks.filter("*", (e) => e);
      hooks.on("*", () => {});
      hooks.late("*", () => {});
    });

    const s = sys.stats();
    expect(s.gates).toEqual({ SessionStart: 1 });
    expect(s.filters).toEqual({ "*": 1 });
    expect(s.handlers).toEqual({ "*": 1 });
    expect(s.lates).toEqual({ "*": 1 });
  });

  // ─── Scoped unload + hot-reload (issue #230) ───

  test("unloadScope('user') removes user hooks but keeps builtin hooks", async () => {
    const sys = new PluginSystem();
    const log: string[] = [];

    sys.load((hooks) => {
      hooks.on("SessionStart", () => log.push("builtin"));
    }, "builtin");
    sys.load((hooks) => {
      hooks.on("SessionStart", () => log.push("user"));
    }, "user");

    await sys.emit(mockEvent);
    expect(log).toEqual(["builtin", "user"]);

    sys.unloadScope("user");
    log.length = 0;
    await sys.emit(mockEvent);
    expect(log).toEqual(["builtin"]);
  });

  test("unloadScope('user') runs user teardowns but not builtin teardowns", () => {
    const sys = new PluginSystem();
    let userTorn = false;
    let builtinTorn = false;

    sys.load(() => () => { builtinTorn = true; }, "builtin");
    sys.load(() => () => { userTorn = true; }, "user");

    sys.unloadScope("user");
    expect(userTorn).toBe(true);
    expect(builtinTorn).toBe(false);
  });

  test("unloadScope drops PluginInfo entries for that scope only", () => {
    const sys = new PluginSystem();
    sys.register("core.ts", "ts", "builtin");
    sys.register("mqtt.ts", "ts", "user");
    sys.register("debug.ts", "ts", "user");

    sys.unloadScope("user");
    const infos = sys.stats().plugins;
    expect(infos.map((p) => p.name)).toEqual(["core.ts"]);
  });

  test("unloadScope clears all 4 hook phases", async () => {
    const sys = new PluginSystem();
    sys.load((hooks) => {
      hooks.gate("SessionStart", () => true);
      hooks.filter("*", (e) => e);
      hooks.on("*", () => {});
      hooks.late("*", () => {});
    }, "user");

    sys.unloadScope("user");
    const s = sys.stats();
    expect(s.gates).toEqual({});
    expect(s.filters).toEqual({});
    expect(s.handlers).toEqual({});
    expect(s.lates).toEqual({});
  });

  test("unloadScope is idempotent (safe to call twice)", () => {
    const sys = new PluginSystem();
    sys.load((hooks) => { hooks.on("*", () => {}); }, "user");

    sys.unloadScope("user");
    expect(() => sys.unloadScope("user")).not.toThrow();
  });

  test("reloadUserPlugins picks up edits to plugin files on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-plugins-"));
    try {
      const file = join(dir, "tap.ts");

      // v1: pushes "v1"
      writeFileSync(
        file,
        `export default function(hooks) { hooks.on("*", (e) => (globalThis as any).__tapLog.push("v1:" + e.event)); }`,
      );
      (globalThis as any).__tapLog = [];

      const sys = new PluginSystem();
      await loadPlugins(sys, dir, "user");
      await sys.emit(mockEvent);
      expect((globalThis as any).__tapLog).toEqual(["v1:SessionStart"]);

      // Edit file to push "v2" instead
      writeFileSync(
        file,
        `export default function(hooks) { hooks.on("*", (e) => (globalThis as any).__tapLog.push("v2:" + e.event)); }`,
      );
      (globalThis as any).__tapLog = [];

      await reloadUserPlugins(sys, dir);
      await sys.emit(mockEvent);
      expect((globalThis as any).__tapLog).toEqual(["v2:SessionStart"]);

      // Handler count stays at 1 — no double-registration
      expect(sys.stats().handlers["*"]).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as any).__tapLog;
    }
  });

  test("reloadUserPlugins does not double-register on successive reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-plugins-"));
    try {
      const file = join(dir, "double.ts");
      writeFileSync(
        file,
        `export default function(hooks) { hooks.on("SessionStart", () => {}); }`,
      );

      const sys = new PluginSystem();
      await loadPlugins(sys, dir, "user");
      expect(sys.stats().handlers.SessionStart).toBe(1);

      await reloadUserPlugins(sys, dir);
      await reloadUserPlugins(sys, dir);
      await reloadUserPlugins(sys, dir);

      expect(sys.stats().handlers.SessionStart).toBe(1);
      expect(sys.stats().plugins.length).toBe(1);
      expect(sys.stats().reloads).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reloadUserPlugins preserves builtin plugins across reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-plugins-"));
    try {
      const file = join(dir, "u.ts");
      writeFileSync(
        file,
        `export default function(hooks) { hooks.on("*", () => (globalThis as any).__uCalls++); }`,
      );
      (globalThis as any).__uCalls = 0;
      (globalThis as any).__bCalls = 0;

      const sys = new PluginSystem();
      sys.load((hooks) => {
        hooks.on("*", () => (globalThis as any).__bCalls++);
      }, "builtin");

      await loadPlugins(sys, dir, "user");
      await sys.emit(mockEvent);
      expect((globalThis as any).__bCalls).toBe(1);
      expect((globalThis as any).__uCalls).toBe(1);

      await reloadUserPlugins(sys, dir);
      await sys.emit(mockEvent);
      expect((globalThis as any).__bCalls).toBe(2); // builtin survived
      expect((globalThis as any).__uCalls).toBe(2); // user re-registered
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as any).__uCalls;
      delete (globalThis as any).__bCalls;
    }
  });

  test("reloadUserPlugins removes a deleted plugin file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-plugins-"));
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      writeFileSync(a, `export default function(h) { h.on("*", () => {}); }`);
      writeFileSync(b, `export default function(h) { h.on("*", () => {}); }`);

      const sys = new PluginSystem();
      await loadPlugins(sys, dir, "user");
      expect(sys.stats().plugins.length).toBe(2);

      rmSync(b);
      await reloadUserPlugins(sys, dir);
      expect(sys.stats().plugins.length).toBe(1);
      expect(sys.stats().plugins[0].name).toBe("a.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stats.reloads increments on each reloadUserPlugins call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-plugins-"));
    try {
      writeFileSync(join(dir, "p.ts"), `export default function(h) { h.on("*", () => {}); }`);
      const sys = new PluginSystem();
      await loadPlugins(sys, dir, "user");
      expect(sys.stats().reloads).toBe(0);

      await reloadUserPlugins(sys, dir);
      expect(sys.stats().reloads).toBe(1);
      expect(sys.stats().lastReloadAt).toBeDefined();

      await reloadUserPlugins(sys, dir);
      expect(sys.stats().reloads).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("load() default scope is 'user' (backwards-compatible)", () => {
    const sys = new PluginSystem();
    sys.load((hooks) => { hooks.on("*", () => {}); });
    // Without explicit scope it defaults to "user" — unloadScope('user') must drop it
    sys.unloadScope("user");
    expect(sys.stats().handlers).toEqual({});
  });
});
