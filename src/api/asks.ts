import { Elysia, t} from "elysia";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const asksPath = join(import.meta.dir, "../../asks.json");

export const asksApi = new Elysia();

asksApi.get("/asks", () => {
  try {
    if (!existsSync(asksPath)) return [];
    return JSON.parse(readFileSync(asksPath, "utf-8"));
  } catch {
    return [];
  }
});

asksApi.post("/asks", async ({ body, set}) => {
  try {
    writeFileSync(asksPath, JSON.stringify(body, null, 2), "utf-8");
    return { ok: true };
  } catch (e: unknown) {
    set.status = 400; return { error: e instanceof Error ? e.message : String(e) };
  }
}, {
  body: t.Unknown(),
});
