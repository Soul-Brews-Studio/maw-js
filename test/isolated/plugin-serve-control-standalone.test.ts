import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
const tmuxCalls: Array<[string, ...unknown[]]> = [];

mock.module("maw-js/config", () => ({
  D: { hmacWindowSeconds: 300 },
  loadConfig: () => ({ host: "local" }),
}));
mock.module(import.meta.resolve("../../src/core/transport/tmux-class.ts"), () => ({
  Tmux: class Tmux {
    async sendKeysLiteral(target: string, text: string) { tmuxCalls.push(["send", target, text]); }
    async sendKeys(target: string, key: string) { tmuxCalls.push(["key", target, key]); }
    async killPane(target: string) { tmuxCalls.push(["kill", target]); }
    async resizePane(target: string, cols: number, rows: number) { tmuxCalls.push(["resize", target, cols, rows]); }
  },
}));

const shareImpl = await import("../../src/vendor/mpr-plugins/share/impl.ts");
const controlPlugin = await import("../../src/vendor/mpr-plugins/serve-control/index.ts?serve-control-standalone");
const auth = await import("../../src/lib/elysia-auth.ts?serve-control-standalone");

beforeEach(() => {
  tmuxCalls.length = 0;
  shareImpl.clearShareRegistry();
});

async function routeHarness() {
  const routes: Array<{ method: string; path: string; handler: (req: Request) => Response | Promise<Response> }> = [];
  const result = await controlPlugin.serve({
    http: {
      route(method: string, path: string, handler: (req: Request) => Response | Promise<Response>) {
        routes.push({ method, path, handler });
      },
    },
  } as any);
  expect(result.ok).toBe(true);
  const route = routes.find((entry) => entry.path === "/api/control/:target/send")!;
  expect(route).toBeTruthy();
  return { routes, handler: route.handler };
}

function req(path: string, body: Record<string, unknown>, token?: string, signature = true): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers["x-maw-control-token"] = token;
    if (signature) headers["x-maw-control-signature"] = controlPlugin.signControlAction(token, "POST", path, raw);
  }
  return new Request(`http://127.0.0.1:3457${path}`, { method: "POST", headers, body: raw });
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

describe("serve-control standalone security gate (#2757)", () => {
  test("standalone boundary and manifest keep serve-control opt-in and out of default-active", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-control",
      requireSdk: false,
      allowMawJs: ["maw-js/config"],
      allowRelative: [
        "../../../core/serve-route-registry",
        "../../../core/transport/tmux-class",
        "../share/impl",
      ],
    });
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/serve-control/plugin.json"), "utf8"));
    expect(manifest.name).toBe("serve-control");
    expect(manifest.hooks.serve.handler).toBe("serve");
    expect(manifest.tier).toBe("extra");
    const defaults = readFileSync(join(root, "src/plugin/default-active.ts"), "utf8");
    expect(defaults).not.toContain('"serve-control"');
  });

  test("elysia auth marks every /api/control/* route protected before plugin dispatch", () => {
    expect(auth.isProtected("/control/%25p/send", "POST")).toBe(true);
    expect(auth.isProtected("/control/%25p/key", "POST")).toBe(true);
    expect(auth.isProtected("/control/%25p/kill", "POST")).toBe(true);
    expect(auth.isProtected("/control/%25p/resize", "POST")).toBe(true);
  });

  test("send requires separate write token, signature, scoped target, and readOnly=false", async () => {
    const { handler } = await routeHarness();
    const share = await shareImpl.createShare({ target: "%1", readOnly: false, control: true });
    expect(share.controlToken).toBeTruthy();
    const path = "/api/control/%251/send";

    let res = await handler(req(path, { slug: share.slug, text: "hi" }));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("control_token_required");

    res = await handler(req(path, { slug: share.slug, text: "hi" }, share.controlToken, false));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("control_signature_required");

    res = await handler(req(path, { slug: share.slug, text: "hi" }, `${share.controlToken}x`));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("invalid_control_token");

    res = await handler(req("/api/control/%252/send", { slug: share.slug, text: "hi" }, share.controlToken));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("target_not_allowed");

    const readonly = await shareImpl.createShare({ target: "%3", readOnly: true });
    res = await handler(req("/api/control/%253/send", { slug: readonly.slug, text: "hi" }, share.controlToken));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("share_read_only");

    res = await handler(req(path, { slug: share.slug, text: `a\0b${"x".repeat(25_000)}` }, share.controlToken));
    expect(res.status).toBe(200);
    expect(tmuxCalls[0][0]).toBe("send");
    expect(tmuxCalls[0][1]).toBe("%1");
    const sent = tmuxCalls[0][2] as string;
    expect(sent.includes("\0")).toBe(false);
    expect(new TextEncoder().encode(sent).byteLength).toBeLessThanOrEqual(20_000);
  });

  test("key verb rejects off-allowlist keys before tmux", async () => {
    const { routes } = await routeHarness();
    const keyRoute = routes.find((entry) => entry.path === "/api/control/:target/key")!;
    const share = await shareImpl.createShare({ target: "%1", readOnly: false, control: true });
    const path = "/api/control/%251/key";
    const res = await keyRoute.handler(req(path, { slug: share.slug, key: "Space" }, share.controlToken));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("key_not_allowed");
    expect(tmuxCalls).toEqual([]);
  });
});
