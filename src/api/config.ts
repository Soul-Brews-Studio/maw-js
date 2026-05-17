import { Elysia, t } from "elysia";
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { type MawConfig, loadConfig, saveConfig, configForDisplay } from "../config";
import { FLEET_DIR as fleetDir } from "../core/paths";

// Rate limit: max 5 attempts per IP per minute
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

export interface ConfigApiDeps {
  readdirSync?: typeof readdirSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  unlinkSync?: typeof unlinkSync;
  existsSync?: typeof existsSync;
  join?: typeof join;
  basename?: typeof basename;
  loadConfig?: typeof loadConfig;
  saveConfig?: typeof saveConfig;
  configForDisplay?: typeof configForDisplay;
  fleetDir?: string;
  rootDir?: string;
  pinAttempts?: Map<string, { count: number; resetAt: number }>;
  now?: () => number;
  createToken?: () => string | Promise<string>;
}

export function createConfigApi(deps: ConfigApiDeps = {}) {
  const readDir = deps.readdirSync ?? readdirSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const writeFile = deps.writeFileSync ?? writeFileSync;
  const rename = deps.renameSync ?? renameSync;
  const unlink = deps.unlinkSync ?? unlinkSync;
  const exists = deps.existsSync ?? existsSync;
  const pathJoin = deps.join ?? join;
  const pathBasename = deps.basename ?? basename;
  const load = deps.loadConfig ?? loadConfig;
  const save = deps.saveConfig ?? saveConfig;
  const displayConfig = deps.configForDisplay ?? configForDisplay;
  const fleetRoot = deps.fleetDir ?? fleetDir;
  const rootDir = deps.rootDir ?? pathJoin(import.meta.dir, "../..");
  const attempts = deps.pinAttempts ?? pinAttempts;
  const now = deps.now ?? (() => Date.now());
  const createAuthToken = deps.createToken ?? (async () => {
    const { createToken } = await import("../lib/auth");
    return createToken();
  });

  const configApi = new Elysia();

  // List all config files (maw.config.json + fleet/*.json + fleet/*.json.disabled)
  configApi.get("/config-files", () => {
    const files: { name: string; path: string; enabled: boolean }[] = [
      { name: "maw.config.json", path: "maw.config.json", enabled: true },
    ];
    try {
      const entries = readDir(fleetRoot).filter((f) => f.endsWith(".json") || f.endsWith(".json.disabled")).sort();
      for (const f of entries) {
        const enabled = !f.endsWith(".disabled");
        files.push({ name: f, path: `fleet/${f}`, enabled });
      }
    } catch { /* expected: fleet dir may not exist */ }
    return { files };
  });

  // Read a single config file
  configApi.get("/config-file", ({ query, set }) => {
    const filePath = query.path;
    if (!filePath) { set.status = 400; return { error: "path required" }; }
    if (filePath.includes("..")) { set.status = 400; return { error: "invalid path" }; }
    const fullPath = pathJoin(rootDir, filePath);
    if (!exists(fullPath)) { set.status = 404; return { error: "not found" }; }
    try {
      const content = readFile(fullPath, "utf-8");
      // For maw.config.json, mask env values
      if (filePath === "maw.config.json") {
        const data = JSON.parse(content);
        const display = displayConfig();
        data.env = display.envMasked;
        return { content: JSON.stringify(data, null, 2) };
      }
      return { content };
    } catch (e: unknown) {
      set.status = 500; return { error: e instanceof Error ? e.message : String(e) };
    }
  }, {
    query: t.Object({ path: t.Optional(t.String()) }),
  });

  // Save a config file
  configApi.post("/config-file", async ({ query, body, set }) => {
    const filePath = query.path;
    if (!filePath) { set.status = 400; return { error: "path required" }; }
    // Only allow maw.config.json and fleet/ files
    if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
      set.status = 403; return { error: "invalid path" };
    }
    try {
      const { content } = body;
      JSON.parse(content); // validate JSON
      const fullPath = pathJoin(rootDir, filePath);
      if (filePath === "maw.config.json") {
        // Handle masked env values
        const parsed = JSON.parse(content);
        if (parsed.env && typeof parsed.env === "object") {
          const current = load();
          for (const [k, v] of Object.entries(parsed.env as Record<string, string>)) {
            if (/\u2022/.test(v)) parsed.env[k] = current.env[k] || v;
          }
        }
        save(parsed);
      } else {
        writeFile(fullPath, content + "\n", "utf-8");
      }
      return { ok: true };
    } catch (e: unknown) {
      set.status = 400; return { error: e instanceof Error ? e.message : String(e) };
    }
  }, {
    query: t.Object({ path: t.Optional(t.String()) }),
    body: t.Object({ content: t.String() }),
  });

  // Toggle enable/disable a fleet file
  configApi.post("/config-file/toggle", ({ query, set }) => {
    const filePath = query.path;
    if (!filePath || !filePath.startsWith("fleet/")) { set.status = 400; return { error: "invalid path" }; }
    const fullPath = pathJoin(rootDir, filePath);
    if (!exists(fullPath)) { set.status = 404; return { error: "not found" }; }
    const isDisabled = filePath.endsWith(".disabled");
    const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
    const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
    rename(fullPath, newPath);
    return { ok: true, newPath: newRelPath };
  }, {
    query: t.Object({ path: t.Optional(t.String()) }),
  });

  // Delete a fleet file
  configApi.delete("/config-file", ({ query, set }) => {
    const filePath = query.path;
    if (!filePath || !filePath.startsWith("fleet/")) { set.status = 400; return { error: "cannot delete" }; }
    const fullPath = pathJoin(rootDir, filePath);
    if (!exists(fullPath)) { set.status = 404; return { error: "not found" }; }
    unlink(fullPath);
    return { ok: true };
  }, {
    query: t.Object({ path: t.Optional(t.String()) }),
  });

  // Create a new fleet file
  configApi.put("/config-file", async ({ body, set }) => {
    const { name, content } = body;
    if (!name || !name.endsWith(".json")) { set.status = 400; return { error: "name must end with .json" }; }
    const safeName = pathBasename(name);
    const fullPath = pathJoin(fleetRoot, safeName);
    try { JSON.parse(content); } catch { set.status = 400; return { error: "invalid JSON" }; }
    // Atomic create: O_CREAT | O_EXCL. Kernel rejects on EEXIST — no TOCTOU window. (#484)
    try {
      writeFile(fullPath, content + "\n", { encoding: "utf-8", flag: "wx" });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        set.status = 409; return { error: "file already exists" };
      }
      throw e;
    }
    return { ok: true, path: `fleet/${safeName}` };
  }, {
    body: t.Object({ name: t.String(), content: t.String() }),
  });

  configApi.get("/pin-info", () => {
    const config = load();
    const pin = config.pin || "";
    return { length: pin.length, enabled: pin.length > 0 };
  });

  configApi.post("/pin-set", async ({ body }) => {
    const { pin } = body;
    const newPin = typeof pin === "string" ? pin.replace(/\D/g, "") : "";
    save({ pin: newPin });
    return { ok: true, length: newPin.length, enabled: newPin.length > 0 };
  }, {
    body: t.Object({ pin: t.Optional(t.String()) }),
  });

  configApi.post("/pin-verify", async ({ body, headers, set }) => {
    const ip = headers["cf-connecting-ip"] || headers["x-forwarded-for"] || "local";
    const currentTime = now();
    const entry = attempts.get(ip) || { count: 0, resetAt: currentTime + 60_000 };
    if (currentTime > entry.resetAt) { entry.count = 0; entry.resetAt = currentTime + 60_000; }
    entry.count++;
    attempts.set(ip, entry);
    if (entry.count > 5) {
      set.status = 429; return { ok: false, error: "Too many attempts. Wait 1 minute." };
    }

    const { pin } = body;
    const config = load();
    const correct = config.pin || "";
    if (!correct) return { ok: true };
    const ok = pin === correct;
    if (ok) {
      attempts.delete(ip);
      return { ok, token: await createAuthToken() };
    }
    return { ok };
  }, {
    body: t.Object({ pin: t.Optional(t.String()) }),
  });

  // PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
  // clients (e.g. maw-ui#8). See docs/federation.md before changing fields.
  configApi.get("/config", ({ query }) => {
    if (query.raw === "1") return load();
    return displayConfig();
  }, {
    query: t.Object({ raw: t.Optional(t.String()) }),
  });

  configApi.post("/config", async ({ body, set }) => {
    try {
      const data = body as Partial<MawConfig>;
      // If env has masked values (bullet chars), keep originals for those keys
      if (data.env && typeof data.env === "object") {
        const current = load();
        const merged: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.env as Record<string, string>)) {
          merged[k] = /\u2022/.test(v) ? (current.env[k] || v) : v;
        }
        data.env = merged;
      }
      save(data);
      return { ok: true };
    } catch (e: unknown) {
      set.status = 400; return { error: e instanceof Error ? e.message : String(e) };
    }
  }, {
    body: t.Unknown(),
  });

  return configApi;
}

export const configApi = createConfigApi();
