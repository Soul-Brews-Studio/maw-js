import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { ServeWsRegistry, type ServeWsSocket } from "../../src/core/serve-ws-registry";
import { serve } from "../../src/vendor/mpr-plugins/serve-ws/index";

const root = join(import.meta.dir, "../..");

type WsCall = { kind: string; msg?: unknown };

function makeSocket(path: string): ServeWsSocket {
  return { data: { target: null, previewTargets: new Set(), __serveWsRoute: path }, send: () => undefined } as unknown as ServeWsSocket;
}

describe("serve-ws plugin", () => {
  test("declares the serve hook and keeps the standalone boundary explicit", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/serve-ws/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.hooks.serve.ensures).toEqual(["ws:route:/ws", "ws:route:/ws/pty", "ws:route:/ws/tmux"]);

    expectStandalonePluginBoundary({
      plugin: "serve-ws",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/\.\.\/core\/serve-ws-registry$/,
        /^\.\.\/\.\.\/\.\.\/core\/transport\/pty$/,
        /^\.\.\/\.\.\/\.\.\/core\/types$/,
        /^\.\.\/\.\.\/\.\.\/api\/tmux-stream$/,
      ],
    });
  });

  test("registers /ws, /ws/pty, and /ws/tmux through the serve hook", () => {
    const registry = new ServeWsRegistry();
    const calls: WsCall[] = [];
    const engine = {
      handleOpen: () => calls.push({ kind: "engine:open" }),
      handleMessage: (_ws: unknown, msg: unknown) => calls.push({ kind: "engine:message", msg }),
      handleClose: () => calls.push({ kind: "engine:close" }),
    };
    const deps = {
      handlePtyMessage: (_ws: unknown, msg: string | Buffer) => calls.push({ kind: "pty:message", msg }),
      handlePtyClose: () => calls.push({ kind: "pty:close" }),
      handleTmuxStreamOpen: () => calls.push({ kind: "tmux:open" }),
      handleTmuxStreamMessage: (_ws: unknown, msg: string | Buffer) => calls.push({ kind: "tmux:message", msg }),
      handleTmuxStreamClose: () => calls.push({ kind: "tmux:close" }),
    } as any;

    expect(serve({ ws: registry, engine: engine as any }, deps)).toEqual({ ok: true, routes: ["/ws/pty", "/ws/tmux", "/ws"] });
    expect(registry.snapshot()).toEqual(["/ws/pty", "/ws/tmux", "/ws"]);

    registry.handlers.open(makeSocket("/ws/tmux"));
    registry.handlers.message(makeSocket("/ws/tmux"), "attach");
    registry.handlers.close(makeSocket("/ws/tmux"));
    registry.handlers.open(makeSocket("/ws"));
    registry.handlers.message(makeSocket("/ws"), "hello");
    registry.handlers.close(makeSocket("/ws"));
    registry.handlers.message(makeSocket("/ws/pty"), "attach");
    registry.handlers.close(makeSocket("/ws/pty"));
    expect(calls).toEqual([
      { kind: "tmux:open" },
      { kind: "tmux:message", msg: "attach" },
      { kind: "tmux:close" },
      { kind: "engine:open" },
      { kind: "engine:message", msg: "hello" },
      { kind: "engine:close" },
      { kind: "pty:message", msg: "attach" },
      { kind: "pty:close" },
    ]);
  });

  test("is idempotent when direct server registration already installed routes", () => {
    const registry = new ServeWsRegistry();
    const engine = { handleOpen() {}, handleMessage() {}, handleClose() {} };
    const deps = {
      handlePtyMessage() {},
      handlePtyClose() {},
      handleTmuxStreamOpen() {},
      handleTmuxStreamMessage() {},
      handleTmuxStreamClose() {},
    } as any;

    serve({ ws: registry, engine: engine as any }, deps);
    expect(() => serve({ ws: registry, engine: engine as any }, deps)).not.toThrow();
    expect(registry.snapshot()).toEqual(["/ws/pty", "/ws/tmux", "/ws"]);
  });

  test("upgrades matching paths with preserved WSData modes", () => {
    const registry = new ServeWsRegistry();
    serve({
      ws: registry,
      engine: { handleOpen() {}, handleMessage() {}, handleClose() {} } as any,
    }, {
      handlePtyMessage() {},
      handlePtyClose() {},
      handleTmuxStreamOpen() {},
      handleTmuxStreamMessage() {},
      handleTmuxStreamClose() {},
    } as any);

    const upgrades: unknown[] = [];
    const okServer = { upgrade: (_req: Request, opts: unknown) => { upgrades.push(opts); return true; } };
    expect(registry.handleUpgrade(new Request("http://local/ws/tmux"), okServer).matched).toBe(true);
    expect(registry.handleUpgrade(new Request("http://local/ws/pty"), okServer).matched).toBe(true);
    expect(registry.handleUpgrade(new Request("http://local/ws"), okServer).matched).toBe(true);
    expect(registry.handleUpgrade(new Request("http://local/not-ws"), okServer)).toEqual({ matched: false });

    expect(upgrades).toMatchObject([
      { data: { target: null, mode: "tmux-stream", __serveWsRoute: "/ws/tmux" } },
      { data: { target: null, mode: "pty", __serveWsRoute: "/ws/pty" } },
      { data: { target: null, __serveWsRoute: "/ws" } },
    ]);
    for (const upgrade of upgrades as Array<{ data: { previewTargets: unknown } }>) {
      expect(upgrade.data.previewTargets).toBeInstanceOf(Set);
    }

    const failed = registry.handleUpgrade(new Request("http://local/ws"), { upgrade: () => false });
    expect(failed.matched).toBe(true);
    expect(failed.response?.status).toBe(400);
  });
});
