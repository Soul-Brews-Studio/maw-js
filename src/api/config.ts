import { Elysia, t} from "elysia";
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { type MawConfig, loadConfig, saveConfig, configForDisplay } from "../config";
import { FLEET_DIR as fleetDir } from "../paths";

export const configApi = new Elysia();

// Rate limit: max 5 attempts per IP per minute
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

// List all config files (maw.config.json + fleet/*.json + fleet/*.json.disabled)
configApi.get("/config-files", () => {
  const files: { name: string; path: string; enabled: boolean }[] = [
    { name: "maw.config.json", path: "maw.config.json", enabled: true },
  ];
  try {
    const entries = readdirSync(fleetDir).filter(f => f.endsWith(".json") || f.endsWith(".json.disabled")).sort();
    for (const f of entries) {
      const enabled = !f.endsWith(".disabled");
      files.push({ name: f, path: `fleet/${f}`, enabled });
    }
  } catch { /* expected: fleet dir may not exist */ }
  return { files };
});

// Read a single config file
configApi.get("/config-file", ({ query, set}) => {
  const filePath = query.path;
  if (!filePath) { set.status = 400; return { error: "path required" }; }
  if (filePath.includes("..")) { set.status = 400; return { error: "invalid path" }; }
  const fullPath = join(import.meta.dir, "../..", filePath);
  if (!existsSync(fullPath)) { set.status = 404; return { error: "not found" }; }
  try {
    const content = readFileSync(fullPath, "utf-8");
    // For maw.config.json, mask env values
    if (filePath === "maw.config.json") {
      const data = JSON.parse(content);
      const display = configForDisplay();
      data.env = display.envMasked;
      return { content: JSON.stringify(data, null, 2) };
    }
    return { content };
  } catch (e: any) {
    set.status = 500; return { error: e.message };
  }
}, {
  query: t.Object({ path: t.Optional(t.String()) }),
});

// Save a config file
configApi.post("/config-file", async ({ query, body, set}) => {
  const filePath = query.path;
  if (!filePath) { set.status = 400; return { error: "path required" }; }
  // Only allow maw.config.json and fleet/ files
  if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
    set.status = 403; return { error: "invalid path" };
  }
  try {
    const { content } = body;
    JSON.parse(content); // validate JSON
    const fullPath = join(import.meta.dir, "../..", filePath);
    if (filePath === "maw.config.json") {
      // Handle masked env values
      const parsed = JSON.parse(content);
      if (parsed.env && typeof parsed.env === "object") {
        const current = loadConfig();
        for (const [k, v] of Object.entries(parsed.env as Record<string, string>)) {
          if (/\u2022/.test(v)) parsed.env[k] = current.env[k] || v;
        }
      }
      saveConfig(parsed);
    } else {
      writeFileSync(fullPath, content + "\n", "utf-8");
    }
    return { ok: true };
  } catch (e: any) {
    set.status = 400; return { error: e.message };
  }
}, {
  query: t.Object({ path: t.Optional(t.String()) }),
  body: t.Object({ content: t.String() }),
});

// Toggle enable/disable a fleet file
configApi.post("/config-file/toggle", ({ query, set}) => {
  const filePath = query.path;
  if (!filePath || !filePath.startsWith("fleet/")) { set.status = 400; return { error: "invalid path" }; }
  const fullPath = join(import.meta.dir, "../..", filePath);
  if (!existsSync(fullPath)) { set.status = 404; return { error: "not found" }; }
  const isDisabled = filePath.endsWith(".disabled");
  const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
  const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
  renameSync(fullPath, newPath);
  return { ok: true, newPath: newRelPath };
}, {
  query: t.Object({ path: t.Optional(t.String()) }),
});

// Delete a fleet file
configApi.delete("/config-file", ({ query, set}) => {
  const filePath = query.path;
  if (!filePath || !filePath.startsWith("fleet/")) { set.status = 400; return { error: "cannot delete" }; }
  const fullPath = join(import.meta.dir, "../..", filePath);
  if (!existsSync(fullPath)) { set.status = 404; return { error: "not found" }; }
  unlinkSync(fullPath);
  return { ok: true };
}, {
  query: t.Object({ path: t.Optional(t.String()) }),
});

// Create a new fleet file
configApi.put("/config-file", async ({ body, set}) => {
  const { name, content } = body;
  if (!name || !name.endsWith(".json")) { set.status = 400; return { error: "name must end with .json" }; }
  const safeName = basename(name);
  const fullPath = join(fleetDir, safeName);
  if (existsSync(fullPath)) { set.status = 409; return { error: "file already exists" }; }
  try { JSON.parse(content); } catch { set.status = 400; return { error: "invalid JSON" }; }
  writeFileSync(fullPath, content + "\n", "utf-8");
  return { ok: true, path: `fleet/${safeName}` };
}, {
  body: t.Object({ name: t.String(), content: t.String() }),
});

configApi.get("/pin-info", () => {
  const config = loadConfig();
  const pin = config.pin || "";
  return { length: pin.length, enabled: pin.length > 0 };
});

configApi.post("/pin-set", async ({ body }) => {
  const { pin } = body;
  const newPin = typeof pin === "string" ? pin.replace(/\D/g, "") : "";
  saveConfig({ pin: newPin } as any);
  return { ok: true, length: newPin.length, enabled: newPin.length > 0 };
}, {
  body: t.Object({ pin: t.Optional(t.String()) }),
});

configApi.post("/pin-verify", async ({ body, headers, set}) => {
  const ip = headers["cf-connecting-ip"] || headers["x-forwarded-for"] || "local";
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  pinAttempts.set(ip, entry);
  if (entry.count > 5) {
    set.status = 429; return { ok: false, error: "Too many attempts. Wait 1 minute." };
  }

  const { pin } = body;
  const config = loadConfig();
  const correct = config.pin || "";
  if (!correct) return { ok: true };
  const ok = pin === correct;
  if (ok) {
    pinAttempts.delete(ip);
    const { createToken } = await import("../lib/auth");
    return { ok, token: createToken() };
  }
  return { ok };
}, {
  body: t.Object({ pin: t.Optional(t.String()) }),
});

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients (e.g. maw-ui#8). See docs/federation.md before changing fields.
configApi.get("/config", ({ query }) => {
  if (query.raw === "1") return loadConfig();
  return configForDisplay();
}, {
  query: t.Object({ raw: t.Optional(t.String()) }),
});

configApi.post("/config", async ({ body, set}) => {
  try {
    const data = body as any;
    // If env has masked values (bullet chars), keep originals for those keys
    if (data.env && typeof data.env === "object") {
      const current = loadConfig();
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.env as Record<string, string>)) {
        merged[k] = /\u2022/.test(v) ? (current.env[k] || v) : v;
      }
      data.env = merged;
    }
    saveConfig(data);
    return { ok: true };
  } catch (e: any) {
    set.status = 400; return { error: e.message };
  }
}, {
  body: t.Unknown(),
});
