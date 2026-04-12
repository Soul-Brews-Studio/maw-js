import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { MAW_ROOT } from "../paths";

export const timemachineView = new Hono();

timemachineView.get("/", (c) => {
  const filePath = join(MAW_ROOT, "office/timemachine.html");
  if (!existsSync(filePath)) {
    return c.text("office/timemachine.html not found — run 'bun run build:office' first", 404);
  }
  const html = readFileSync(filePath, "utf-8");
  return c.html(html);
});
