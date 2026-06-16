import { Hono } from "hono";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { serveStatic } from "hono/bun";
import { mountViews } from "../../../views/index";
import { mawDataPath } from "../../../core/xdg";
import type { ServeHookContext } from "../../../core/serve-route-registry";

export function createViews(
  mawUiDir = process.env.MAW_UI_DIR || mawDataPath("ui", "dist"),
  doorHtmlPath = join(import.meta.dir, "../../../core/static/door.html"),
) {
  const views = new Hono();

  // Fleet topology visualization
  views.get("/topology", async (c) => {
    const path = require("path").resolve(process.cwd(), "ψ/outbox/fleet-topology.html");
    try {
      const html = require("fs").readFileSync(path, "utf-8");
      return c.html(html);
    } catch { return c.text("fleet-topology.html not found", 404); }
  });

  mountViews(views);

  // Serve packed maw-ui dist (Shape A — single port, single process)
  if (existsSync(mawUiDir)) {
    views.use("/*", serveStatic({ root: mawUiDir }));
  } else {
    // The Door — minimal landing page when no packed maw-ui is installed.
    // Lets users connect to any federation by pasting an address.
    let doorHtml: string;
    try {
      doorHtml = readFileSync(doorHtmlPath, "utf-8");
    } catch {
      // door.html missing (e.g. fresh clone without assets) — serve inline stub
      doorHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>maw</title></head><body style="font-family:monospace;background:#0d0d0d;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#fff">maw</h1><p>maw-ui not installed. Run <code style="color:#7dd3fc">maw ui build</code> or install maw-ui.</p></div></body></html>`;
    }
    views.get("/", (c) => c.html(doorHtml));
  }

  views.onError((err, c) => c.json({ error: err.message }, 500));

  return views;
}

export const views = createViews();

function hasServeViewsFallback(http: ServeHookContext["http"]): boolean {
  const listFallbacks = (http as { listFallbacks?: () => string[] } | undefined)?.listFallbacks;
  if (typeof listFallbacks !== "function") return false;
  return listFallbacks.call(http).includes("serve-views");
}

export async function serve(
  ctx: ServeHookContext,
  options: { views?: Hono } = {},
): Promise<{ ok: true }> {
  if (!ctx.http?.fallback) return { ok: true };
  if (hasServeViewsFallback(ctx.http)) return { ok: true };
  const honoViews = options.views ?? createViews();
  try {
    ctx.http.fallback("serve-views", (req, env) => honoViews.fetch(req, env));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("serve fallback already registered: serve-views")) {
      return { ok: true };
    }
    throw error;
  }
  return { ok: true };
}
