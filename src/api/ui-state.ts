import { Elysia, t} from "elysia";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DEFAULT_PATH = join(import.meta.dir, "../../ui-state.json");

let cachedState: object | null = null;

export function readUiState(filePath = DEFAULT_PATH): object {
  if (cachedState !== null) return cachedState;
  try {
    if (!existsSync(filePath)) return {};
    cachedState = JSON.parse(readFileSync(filePath, "utf-8"));
    return cachedState!;
  } catch {
    return {};
  }
}

export function writeUiState(data: object, filePath = DEFAULT_PATH): void {
  cachedState = data;
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function invalidateUiStateCache(): void {
  cachedState = null;
}

export interface UiStateApiDeps {
  readUiState: typeof readUiState;
  writeUiState: typeof writeUiState;
}

export function createUiStateApi(deps: UiStateApiDeps = {
  readUiState,
  writeUiState,
}) {
  const api = new Elysia();

  api.get("/ui-state", () => {
    return deps.readUiState();
  });

  api.post("/ui-state", async ({ body, set}) => {
    try {
      deps.writeUiState(body as object);
      return { ok: true };
    } catch (e: any) {
      set.status = 400; return { error: e.message };
    }
  }, {
    body: t.Unknown(),
  });

  return api;
}

export const uiStateApi = createUiStateApi();
