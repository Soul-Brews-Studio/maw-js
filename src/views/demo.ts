import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { MAW_ROOT } from "../core/paths";

export const demoView = new Hono();

demoView.get("/", serveStatic({ root: `${MAW_ROOT}/demo`, path: "/index.html" }));
demoView.get("/*", serveStatic({ root: MAW_ROOT }));
