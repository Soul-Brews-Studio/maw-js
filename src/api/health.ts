import { Hono } from "hono";
import { getDb } from "../db";
import { schema } from "../db";
import { desc, gte } from "drizzle-orm";

export const healthApi = new Hono();

/** Collect fresh server metrics from the VPS */
function collectMetrics(): {
  memAvailMb: number;
  memTotalMb: number;
  memUsedPct: number;
  diskUsedPct: number;
  diskAvailGb: number;
  loadAvg: string;
  cpuCount: number;
  pm2Online: number;
  pm2Total: number;
  dockerRunning: number;
  dockerTotal: number;
} {
  const { execSync } = require("child_process");

  // Memory from /proc/meminfo
  const meminfo = require("fs").readFileSync("/proc/meminfo", "utf-8");
  const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || "0") / 1024;
  const memAvail = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || "0") / 1024;
  const memUsedPct = memTotal > 0 ? Math.round(((memTotal - memAvail) / memTotal) * 100) : 0;

  // Disk
  let diskUsedPct = 0;
  let diskAvailGb = 0;
  try {
    const df = execSync("df / --output=pcent,avail | tail -1", { timeout: 5000 }).toString().trim();
    const parts = df.split(/\s+/);
    diskUsedPct = parseInt(parts[0]?.replace("%", "") || "0");
    diskAvailGb = Math.round(parseInt(parts[1] || "0") / 1024 / 1024);
  } catch {}

  // Load
  let loadAvg = "0 0 0";
  try {
    loadAvg = require("fs").readFileSync("/proc/loadavg", "utf-8").split(" ").slice(0, 3).join(" ");
  } catch {}

  // CPU count
  let cpuCount = 1;
  try {
    const cpuinfo = require("fs").readFileSync("/proc/cpuinfo", "utf-8");
    cpuCount = (cpuinfo.match(/^processor/gm) || []).length || 1;
  } catch {}

  // PM2
  let pm2Online = 0;
  let pm2Total = 0;
  try {
    const pm2Json = execSync("pm2 jlist 2>/dev/null", { timeout: 5000 }).toString();
    const pm2List = JSON.parse(pm2Json);
    pm2Total = pm2List.length;
    pm2Online = pm2List.filter((p: any) => p.pm2_env?.status === "online").length;
  } catch {}

  // Docker
  let dockerRunning = 0;
  let dockerTotal = 0;
  try {
    const dockerPs = execSync('docker ps -a --format "{{.Status}}"', { timeout: 5000 }).toString().trim();
    if (dockerPs) {
      const lines = dockerPs.split("\n");
      dockerTotal = lines.length;
      dockerRunning = lines.filter((l: string) => l.startsWith("Up")).length;
    }
  } catch {}

  return {
    memAvailMb: Math.round(memAvail),
    memTotalMb: Math.round(memTotal),
    memUsedPct,
    diskUsedPct,
    diskAvailGb,
    loadAvg,
    cpuCount,
    pm2Online,
    pm2Total,
    dockerRunning,
    dockerTotal,
  };
}

/** Check alert thresholds, return reason or null */
function checkAlerts(metrics: ReturnType<typeof collectMetrics>): string | null {
  const reasons: string[] = [];
  if (metrics.memAvailMb < 200) reasons.push(`mem_low:${metrics.memAvailMb}MB`);
  if (metrics.diskUsedPct > 95) reasons.push(`disk_high:${metrics.diskUsedPct}%`);
  return reasons.length > 0 ? reasons.join(",") : null;
}

/** Fire webhook if configured (Discord format) */
async function fireWebhook(metrics: ReturnType<typeof collectMetrics>, alertReason: string) {
  const webhookUrl = process.env.PULSE_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = {
    content: `🫀 **Pulse Alert** — ${alertReason}`,
    embeds: [{
      color: 0xff4444,
      title: "Server Health Alert",
      fields: [
        { name: "Memory", value: `${metrics.memAvailMb}MB / ${metrics.memTotalMb}MB (${metrics.memUsedPct}%)`, inline: true },
        { name: "Disk", value: `${metrics.diskUsedPct}% used (${metrics.diskAvailGb}GB free)`, inline: true },
        { name: "Load", value: metrics.loadAvg, inline: true },
        { name: "PM2", value: `${metrics.pm2Online}/${metrics.pm2Total} online`, inline: true },
        { name: "Docker", value: `${metrics.dockerRunning}/${metrics.dockerTotal} running`, inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "srv1439136.local — Pulse Oracle" },
    }],
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[pulse] webhook failed:", e);
  }
}

/** POST /health/collect — called by heartbeat.sh or manually */
healthApi.post("/health/collect", async (c) => {
  try {
    const db = getDb();
    const now = Date.now();
    const metrics = collectMetrics();
    const alertReason = checkAlerts(metrics);
    const alertFired = alertReason ? 1 : 0;

    await db.insert(schema.healthSnapshots).values({
      ts: now,
      timestamp: new Date(now).toISOString(),
      ...metrics,
      alertFired,
      alertReason,
    });

    // Fire webhook on alert
    if (alertReason) {
      await fireWebhook(metrics, alertReason);
    }

    // Prune old entries (keep 7 days = 2016 entries at 5min intervals)
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    db.delete(schema.healthSnapshots).where(
      require("drizzle-orm").lt(schema.healthSnapshots.ts, cutoff)
    ).run();

    return c.json({ ok: true, alertFired, alertReason, ...metrics });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** GET /health/history — return health timeline */
healthApi.get("/health/history", async (c) => {
  try {
    const db = getDb();
    const hours = parseInt(c.req.query("hours") || "24", 10);
    const cutoff = Date.now() - hours * 60 * 60 * 1000;

    const rows = await db
      .select()
      .from(schema.healthSnapshots)
      .where(gte(schema.healthSnapshots.ts, cutoff))
      .orderBy(desc(schema.healthSnapshots.ts))
      .limit(500);

    return c.json({ snapshots: rows, hours });
  } catch (e: any) {
    return c.json({ snapshots: [], error: e.message });
  }
});

/** GET /health/latest — current server status */
healthApi.get("/health/latest", async (c) => {
  try {
    const metrics = collectMetrics();
    const alertReason = checkAlerts(metrics);
    return c.json({
      ...metrics,
      timestamp: new Date().toISOString(),
      alertFired: alertReason ? true : false,
      alertReason,
      webhookConfigured: !!process.env.PULSE_WEBHOOK_URL,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
