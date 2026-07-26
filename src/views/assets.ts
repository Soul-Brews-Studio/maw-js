import { Hono } from "hono";
import { existsSync } from "fs";
import { join } from "path";

/**
 * kobo-398 — a dedicated, SAME-ORIGIN static-asset surface. There is NO existing
 * `/assets/*` route (grep-confirmed before writing this file) — this is a new
 * one, mounted the same way every other top-level view is (src/views/index.ts).
 *
 * Serves mermaid.js DIRECTLY from the pinned npm dependency at request time via
 * Bun.file — no build stage, no copied artifact that can drift from the pinned
 * version (package.json exact-pins `mermaid`, no caret). `?v=` is a client-
 * supplied cache-bust value; the server ignores it and always serves the
 * currently-installed pinned file — bumping the npm pin is the only way the
 * served bytes change.
 *
 * Same-origin (no CDN `script-src`), lazy-loaded by room.ts only when a
 * ```mermaid block is actually present (kobo-398 mechanism).
 */
const MERMAID_JS_PATH = join(import.meta.dir, "..", "..", "node_modules", "mermaid", "dist", "mermaid.min.js");

export const assetsView = new Hono();

assetsView.get("/vendor/mermaid.js", (c) => {
  if (!existsSync(MERMAID_JS_PATH)) return c.text("mermaid asset not installed", 404);
  return new Response(Bun.file(MERMAID_JS_PATH), { headers: { "content-type": "application/javascript" } });
});
