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
      process.stderr.write("→ maw-ui not found. Run `maw ui build` or install maw-ui.\n");
      doorHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>maw</title></head><body style="font-family:monospace;background:#0d0d0d;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#fff">maw</h1><p>maw-ui not installed. Run <code style="color:#7dd3fc">maw ui build</code> or install maw-ui.</p></div></body></html>`;
    }
    views.get("/", (c) => c.html(doorHtml));
  }

  views.onError((err, c) => c.json({ error: err.message }, 500));

  return views;
}

export const views = createViews();

export async function serve(
  ctx: ServeHookContext,
  options: { views?: Hono } = {},
): Promise<{ ok: true }> {
  if (!ctx.http?.fallback) return { ok: true };
  const honoViews = options.views ?? createViews();
  ctx.http.fallback("serve-views", (req, env) => honoViews.fetch(req, env));
  return { ok: true };
}
