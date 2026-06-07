import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { ServeWsRegistry, type ServeWsSocket } from "../../src/core/serve-ws-registry";
import {
  registerServeTmuxStreamWsRoute,
  serve,
} from "../../src/vendor-plugins/serve-tmux-stream-ws/index.ts?plugin-serve-tmux-stream-ws-standalone";

const root = join(import.meta.dir, "../..");

type WsCall = { kind: string; msg?: unknown };

function makeSocket(path: string): ServeWsSocket {
  return { data: { target: null, previewTargets: new Set(), __serveWsRoute: path }, send: () => undefined } as unknown as ServeWsSocket;
}

describe("serve-tmux-stream-ws plugin standalone boundary", () => {
  test("declares the serve hook and keeps the standalone boundary explicit", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-tmux-stream-ws/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.hooks.serve.ensures).toEqual(["ws:route:/ws/tmux"]);
    expect(manifest.module.exports).toContain("registerServeTmuxStreamWsRoute");

    expectStandalonePluginBoundary({
      plugin: "serve-tmux-stream-ws",
      pluginDir: "src/vendor-plugins/serve-tmux-stream-ws",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/api\/tmux-stream$/,
        /^\.\.\/\.\.\/core\/serve-ws-registry$/,
        /^\.\.\/\.\.\/core\/types$/,
      ],
    });
  });

  test("registers only the tmux stream websocket route through the serve hook", () => {
    const registry = new ServeWsRegistry();
    const calls: WsCall[] = [];
    const deps = {
      handleTmuxStreamOpen: () => calls.push({ kind: "tmux:open" }),
      handleTmuxStreamMessage: (_ws: unknown, msg: unknown) => calls.push({ kind: "tmux:message", msg }),
      handleTmuxStreamClose: () => calls.push({ kind: "tmux:close" }),
    } as any;

    expect(serve({ ws: registry }, deps)).toEqual({ ok: true, routes: ["/ws/tmux"] });
    expect(registry.snapshot()).toEqual(["/ws/tmux"]);

    registry.handlers.open(makeSocket("/ws/tmux"));
    registry.handlers.message(makeSocket("/ws/tmux"), "refresh");
    registry.handlers.close(makeSocket("/ws/tmux"));

    expect(calls).toEqual([
      { kind: "tmux:open" },
      { kind: "tmux:message", msg: "refresh" },
      { kind: "tmux:close" },
    ]);
  });

  test("upgrades /ws/tmux with tmux-stream WSData mode", () => {
    const registry = new ServeWsRegistry();
    registerServeTmuxStreamWsRoute({ ws: registry }, {
      handleTmuxStreamOpen() {},
      handleTmuxStreamMessage() {},
      handleTmuxStreamClose() {},
    } as any);

    const upgrades: unknown[] = [];
    const okServer = { upgrade: (_req: Request, opts: unknown) => { upgrades.push(opts); return true; } };
    expect(registry.handleUpgrade(new Request("http://local/ws/tmux"), okServer).matched).toBe(true);
    expect(registry.handleUpgrade(new Request("http://local/ws"), okServer)).toEqual({ matched: false });

    expect(upgrades).toMatchObject([
      { data: { target: null, mode: "tmux-stream", __serveWsRoute: "/ws/tmux" } },
    ]);
    expect((upgrades[0] as { data: { previewTargets: unknown } }).data.previewTargets).toBeInstanceOf(Set);

    const failed = registry.handleUpgrade(new Request("http://local/ws/tmux"), { upgrade: () => false });
    expect(failed.matched).toBe(true);
    expect(failed.response?.status).toBe(400);
  });

  test("serve hook fails clearly without ws route registration context", () => {
    expect(() => serve({})).toThrow("serve-tmux-stream-ws requires serve ws route registration");
  });
});
