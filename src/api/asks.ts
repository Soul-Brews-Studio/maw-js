import { Elysia, t} from "elysia";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const asksPath = join(import.meta.dir, "../../asks.json");

export interface AsksApiDeps {
  asksPath: string;
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
}

export function createAsksApi(deps: AsksApiDeps = {
  asksPath,
  existsSync,
  readFileSync,
  writeFileSync,
}) {
  const api = new Elysia();

  api.get("/asks", () => {
    try {
      if (!deps.existsSync(deps.asksPath)) return [];
      return JSON.parse(deps.readFileSync(deps.asksPath, "utf-8") as string);
    } catch {
      return [];
    }
  });

  api.post("/asks", async ({ body, set}) => {
    try {
      deps.writeFileSync(deps.asksPath, JSON.stringify(body, null, 2), "utf-8");
      return { ok: true };
    } catch (e: any) {
      set.status = 400; return { error: e.message };
    }
  }, {
    body: t.Unknown(),
  });

  return api;
}

export const asksApi = createAsksApi();
