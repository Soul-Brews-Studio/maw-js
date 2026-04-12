import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { MAW_ROOT } from "../paths";

export const federationView = new Hono();

federationView.get("/", (c) => {
  const filePath = join(MAW_ROOT, "office/federation.html");
  if (!existsSync(filePath)) {
    return c.text("office/federation.html not found — run 'bun run build:office' first", 404);
  }
  const html = readFileSync(filePath, "utf-8");
  return c.html(html);
});
