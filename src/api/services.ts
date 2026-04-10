import { Hono } from "hono";
import { execSync } from "child_process";

const PM2 = "/home/lfz/.bun/bin/pm2";

function pm2List() {
  try {
    const out = execSync(`${PM2} jlist 2>/dev/null`, { encoding: "utf-8" });
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
  try {
    execSync(`${PM2} restart ${name} 2>&1`);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

servicesApi.post("/services/:name/stop", (c) => {
  const { name } = c.req.param();
  try {
    execSync(`${PM2} stop ${name} 2>&1`);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

servicesApi.post("/services/:name/start", (c) => {
  const { name } = c.req.param();
  try {
    execSync(`${PM2} start ${name} 2>&1`);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});
