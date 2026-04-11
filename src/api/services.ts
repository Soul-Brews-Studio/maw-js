import { Hono } from "hono";
import { execFileSync } from "child_process";

const PM2 = "/home/lfz/.bun/bin/pm2";

// Allowlist of PM2 process names the /api/services control plane may touch.
// Mirrors src/api/dispatch.ts ORACLE_TARGETS for the Oracle fleet panes, plus
// the maw ecosystem processes from ecosystem.config.cjs and the oracle-v3
// MCP. "sofia" is deliberately NOT in this set — /api/services is for PM2
// management, not Oracle messaging, and there is no reason this endpoint
// should ever restart the commander's pane. The Path A' reasoning that put
// sofia back into /api/send does not apply here.
const ALLOWED_SERVICE_NAMES = new Set([
  // maw ecosystem
  "maw", "maw-js", "maw-ui", "maw-broker", "maw-boot",
  // oracle-v3 MCP
  "oracle-v3",
  // Oracle fleet panes
  "01-blade", "02-link", "03-bastion", "04-lens", "05-edge",
  "06-clip", "07-deck", "08-scope", "09-quill", "10-sage",
  "11-warden", "12-prism",
]);

function validateServiceName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return ALLOWED_SERVICE_NAMES.has(trimmed) ? trimmed : null;
}

function pm2List() {
  try {
    const out = execFileSync(PM2, ["jlist"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

export const servicesApi = new Hono();

servicesApi.get("/services", (c) => {
  const list = pm2List();
  const services = list.map((p: any) => ({
    id: p.pm_id,
    name: p.name,
    status: p.pm2_env?.status ?? "unknown",
    pid: p.pid,
    cpu: p.monit?.cpu ?? 0,
    memory: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
    restarts: p.pm2_env?.restart_time ?? 0,
    uptime: p.pm2_env?.pm_uptime ?? null,
    script: p.pm2_env?.pm_exec_path ?? "",
  }));
  return c.json({ services });
});

servicesApi.post("/services/:name/restart", (c) => {
  const { name } = c.req.param();
  const safe = validateServiceName(name);
  if (!safe) return c.json({ ok: false, error: `service not allowed: ${name}` }, 403);
  try {
    execFileSync(PM2, ["restart", safe], { encoding: "utf-8", stdio: "pipe" });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

servicesApi.post("/services/:name/stop", (c) => {
  const { name } = c.req.param();
  const safe = validateServiceName(name);
  if (!safe) return c.json({ ok: false, error: `service not allowed: ${name}` }, 403);
  try {
    execFileSync(PM2, ["stop", safe], { encoding: "utf-8", stdio: "pipe" });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

servicesApi.post("/services/:name/start", (c) => {
  const { name } = c.req.param();
  const safe = validateServiceName(name);
  if (!safe) return c.json({ ok: false, error: `service not allowed: ${name}` }, 403);
  try {
    execFileSync(PM2, ["start", safe], { encoding: "utf-8", stdio: "pipe" });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});
