import { Hono } from "hono";
import { execFileSync } from "child_process";

const PM2 = "/home/lfz/.bun/bin/pm2";

// Exact-match allowlist of PM2-registered process names that /api/services
// may cycle. Limited to the three processes currently registered in live
// PM2 on a running maw host: maw-js (backend server), maw-ui (vite dev
// server), and oracle-v3 (MCP server).
//
// Intentionally excluded (Warden R6 NEW-11 — aspirational vs reality):
//   - maw / maw-broker / maw-boot: declared in ecosystem.config.cjs but
//     not currently registered in PM2. maw runs under the "maw-js"
//     registration (historical). maw-broker refuses to start without
//     federationToken (P2b fail-closed). maw-boot is a one-shot wake
//     command (autorestart: false). Re-add individually via a focused
//     follow-up brief if either comes online.
//   - 01-blade through 12-prism: Oracle fleet panes are tmux-managed,
//     not PM2-managed. `pm2 restart 01-blade` errors at PM2 name lookup
//     (evidenced live in Warden R6 probes §A3/§A4). Oracle pane
//     lifecycle belongs in a tmux-aware endpoint, not /api/services.
//   - sofia / 00-sofia: Path A' (e5007e3) reasoning scopes to /api/send
//     messaging, not PM2 management. The commander's pane must never be
//     a cycle target of this endpoint.
const ALLOWED_SERVICE_NAMES = new Set([
  "maw-js",
  "maw-ui",
  "oracle-v3",
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
