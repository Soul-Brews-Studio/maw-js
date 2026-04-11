import { Hono } from "hono";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR as fleetDir } from "../paths";
import { z } from "zod/v4";

export const fleetApi = new Hono();

fleetApi.get("/fleet-config", (c) => {
  try {
    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => JSON.parse(readFileSync(join(fleetDir, f), "utf-8")));
    return c.json({ configs });
  } catch (e: any) {
    return c.json({ configs: [], error: e.message });
  }
});

/** Soul-sync status — parent/child tree with config diffs */
fleetApi.get("/fleet/soul-sync-status", (c) => {
  try {
    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs: Record<string, any> = {};
    for (const f of files) {
      const cfg = JSON.parse(readFileSync(join(fleetDir, f), "utf-8"));
      configs[cfg.name || f.replace(".json", "")] = { ...cfg, _file: f };
    }

    // Find parent and children
    const parent = Object.values(configs).find((c: any) => c.children?.length > 0);
    if (!parent) return c.json({ tree: null, message: "No parent with children found" });

    const children = (parent.children as string[]).map((name: string) => {
      // Match by name, session, or partial match (e.g. "neo" matches "02-neo")
      const child = Object.values(configs).find((c: any) =>
        (c.name || c.session) === name ||
        (c.name || "").includes(name) ||
        (c.windows?.[0]?.name || "").replace("-oracle", "") === name
      );
      if (!child) return { name, status: "missing", diff: [] };

      // Compute config diff (fields that differ from parent, excluding identity fields)
      const skipKeys = new Set(["name", "session", "children", "parent", "_file", "id", "theme", "role"]);
      const diff: { key: string; parent: any; child: any }[] = [];
      const allKeys = new Set([...Object.keys(parent), ...Object.keys(child)]);
      for (const key of allKeys) {
        if (skipKeys.has(key)) continue;
        const pVal = JSON.stringify(parent[key]);
        const cVal = JSON.stringify(child[key]);
        if (pVal !== cVal) diff.push({ key, parent: parent[key], child: child[key] });
      }

      return { name, status: "connected", diff, config: child };
    });

    return c.json({
      tree: {
        parent: { name: parent.name || parent.session, config: parent },
        children,
      },
    });
  } catch (e: any) {
    return c.json({ tree: null, error: e.message });
  }
});

const SoulSyncBody = z.object({
  fields: z.array(z.string()).optional(),
  targets: z.array(z.string()).optional(),
});

/** Soul-sync trigger — sync specific fields from parent to children */
fleetApi.post("/fleet/soul-sync", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = SoulSyncBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { fields, targets } = parsed.data;

    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs: Record<string, { data: any; file: string }> = {};
    for (const f of files) {
      const cfg = JSON.parse(readFileSync(join(fleetDir, f), "utf-8"));
      configs[cfg.name || cfg.session || f.replace(".json", "")] = { data: cfg, file: f };
    }

    const parent = Object.values(configs).find(c => c.data.children?.length > 0);
    if (!parent) return c.json({ error: "No parent found" }, 400);

    const childNames: string[] = targets || parent.data.children || [];
    const syncFields = fields || Object.keys(parent.data).filter(
      k => !["name", "session", "children", "parent", "id", "theme", "role"].includes(k)
    );

    const synced: string[] = [];
    for (const name of childNames) {
      // Match by exact name, partial name (e.g. "neo" matches "02-neo"), or window name
      const child = configs[name] || Object.values(configs).find(c =>
        (c.data.name || "").includes(name) ||
        (c.data.windows?.[0]?.name || "").replace("-oracle", "") === name
      );
      if (!child) continue;
      for (const field of syncFields) {
        if (parent.data[field] !== undefined) {
          child.data[field] = parent.data[field];
        }
      }
      writeFileSync(join(fleetDir, child.file), JSON.stringify(child.data, null, 2) + "\n");
      synced.push(name);
    }

    return c.json({ synced, fields: syncFields });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
