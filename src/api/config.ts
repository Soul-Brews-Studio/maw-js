import { Hono } from "hono";
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { join, basename } from "path";
import { loadConfig, saveConfig, configForDisplay } from "../config";
import { FLEET_DIR as fleetDir } from "../paths";

export const configApi = new Hono();

// Rate limit: max 5 attempts per IP per minute
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

// List all config files (maw.config.json + fleet/*.json + fleet/*.json.disabled)
configApi.get("/config-files", (c) => {
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
  return c.json({ files });
});

// Read a single config file
configApi.get("/config-file", (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  if (filePath.includes("..")) return c.json({ error: "invalid path" }, 400);
  const fullPath = join(import.meta.dir, "../..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  try {
    const content = readFileSync(fullPath, "utf-8");
    // For maw.config.json, mask env values
    if (filePath === "maw.config.json") {
      const data = JSON.parse(content);
      const display = configForDisplay();
      data.env = display.envMasked;
      return c.json({ content: JSON.stringify(data, null, 2) });
    }
    return c.json({ content });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Save a config file
configApi.post("/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);
  // Only allow maw.config.json and fleet/ files
  if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
    return c.json({ error: "invalid path" }, 403);
  }
  try {
    const { content } = await c.req.json();
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
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// Toggle enable/disable a fleet file
configApi.post("/config-file/toggle", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/")) return c.json({ error: "invalid path" }, 400);
  const fullPath = join(import.meta.dir, "../..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  const isDisabled = filePath.endsWith(".disabled");
  const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
  const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
  renameSync(fullPath, newPath);
  return c.json({ ok: true, newPath: newRelPath });
});

// Delete a fleet file
configApi.delete("/config-file", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath || !filePath.startsWith("fleet/")) return c.json({ error: "cannot delete" }, 400);
  const fullPath = join(import.meta.dir, "../..", filePath);
  if (!existsSync(fullPath)) return c.json({ error: "not found" }, 404);
  unlinkSync(fullPath);
  return c.json({ ok: true });
});

// Create a new fleet file
configApi.put("/config-file", async (c) => {
  const { name, content } = await c.req.json();
  if (!name || !name.endsWith(".json")) return c.json({ error: "name must end with .json" }, 400);
  const safeName = basename(name);
  const fullPath = join(fleetDir, safeName);
  if (existsSync(fullPath)) return c.json({ error: "file already exists" }, 409);
  try { JSON.parse(content); } catch { return c.json({ error: "invalid JSON" }, 400); }
  writeFileSync(fullPath, content + "\n", "utf-8");
  return c.json({ ok: true, path: `fleet/${safeName}` });
});

configApi.get("/pin-info", (c) => {
  const config = loadConfig() as any;
  const pin = config.pin || "";
  return c.json({ length: pin.length, enabled: pin.length > 0 });
});

configApi.post("/pin-set", async (c) => {
  const { pin } = await c.req.json();
  const newPin = typeof pin === "string" ? pin.replace(/\D/g, "") : "";
  saveConfig({ pin: newPin } as any);
  return c.json({ ok: true, length: newPin.length, enabled: newPin.length > 0 });
});

configApi.post("/pin-verify", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "local";
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  pinAttempts.set(ip, entry);
  if (entry.count > 5) {
    return c.json({ ok: false, error: "Too many attempts. Wait 1 minute." }, 429);
  }

  const { pin } = await c.req.json();
  const config = loadConfig() as any;
  const correct = config.pin || "";
  if (!correct) return c.json({ ok: true });
  const ok = pin === correct;
  if (ok) pinAttempts.delete(ip); // reset on success
  return c.json({ ok });
});

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients (e.g. maw-ui#8). See docs/federation.md before changing fields.
configApi.get("/config", (c) => {
  if (c.req.query("raw") === "1") return c.json(loadConfig());
  return c.json(configForDisplay());
});

configApi.post("/config", async (c) => {
  try {
    const body = await c.req.json();
    // If env has masked values (bullet chars), keep originals for those keys
    if (body.env && typeof body.env === "object") {
      const current = loadConfig();
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env as Record<string, string>)) {
        merged[k] = /\u2022/.test(v) ? (current.env[k] || v) : v;
      }
      body.env = merged;
    }
    saveConfig(body);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
