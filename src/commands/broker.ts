import { execSync } from "child_process";
import { loadConfig, saveConfig } from "../config";
import { MAW_ROOT } from "../paths";

function pm2BrokerStatus(): { online: boolean; pid?: number; uptime?: string } {
  try {
    const raw = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8" });
    const procs = JSON.parse(raw);
    const broker = procs.find((p: any) => p.name === "maw-broker");
    if (!broker) return { online: false };
    const online = broker.pm2_env?.status === "online";
    const upMs = online ? Date.now() - broker.pm2_env?.pm_uptime : 0;
    const uptime = upMs > 0 ? `${Math.floor(upMs / 60000)}m` : "";
    return { online, pid: broker.pid, uptime };
  } catch {
    return { online: false };
  }
}

function hasMosquitto(): string | null {
  try {
    const path = execSync("which mosquitto 2>/dev/null", { encoding: "utf-8" }).trim();
    return path || null;
  } catch {
    return null;
  }
}

function isMosquittoRunning(port: number): boolean {
  try {
    const out = execSync(`ss -tlnp sport = :${port} 2>/dev/null`, { encoding: "utf-8" });
    return out.includes("mosquitto");
  } catch {
    return false;
  }
}

export async function cmdBrokerStart(): Promise<void> {
  const config = loadConfig();
  const mqttPort = config.mqtt?.port || 1883;
  const wsPort = config.mqtt?.wsPort || 9883;

  // Check if system mosquitto is already running
  if (isMosquittoRunning(mqttPort)) {
    console.log(`\x1b[32m✓\x1b[0m system mosquitto already running on :${mqttPort}`);
    saveConfig({ mqtt: { ...config.mqtt, broker: `mqtt://localhost:${mqttPort}` } });
    return;
  }

  const status = pm2BrokerStatus();
  if (status.online) {
    console.log(`\x1b[33m⚡\x1b[0m broker already running (pid ${status.pid})`);
    return;
  }

  // Prefer system mosquitto
  const mosquittoPath = hasMosquitto();
  if (mosquittoPath) {
    // Generate minimal mosquitto config
    const confPath = "/tmp/maw-mosquitto.conf";
    const conf = [
      `listener ${mqttPort}`,
      `protocol mqtt`,
      `listener ${wsPort}`,
      `protocol websockets`,
      `allow_anonymous true`,
      `log_type error`,
      `log_type warning`,
    ].join("\n");
    require("fs").writeFileSync(confPath, conf + "\n");

    try {
      execSync(`pm2 start ${mosquittoPath} --name maw-broker -- -c ${confPath}`, { cwd: MAW_ROOT, stdio: "pipe" });
      console.log(`\x1b[32m✓\x1b[0m broker started (mosquitto) on :${mqttPort} (TCP) + :${wsPort} (WS)`);
    } catch (e: any) {
      console.error(`\x1b[31m✗\x1b[0m mosquitto start failed: ${e.message}`);
      return;
    }
  } else {
    // Fallback to Aedes
    try {
      execSync(`pm2 start ecosystem.config.cjs --only maw-broker`, { cwd: MAW_ROOT, stdio: "pipe" });
      console.log(`\x1b[32m✓\x1b[0m broker started (aedes) on :${mqttPort} (TCP) + :${wsPort} (WS)`);
    } catch (e: any) {
      console.error(`\x1b[31m✗\x1b[0m broker start failed: ${e.message}`);
      return;
    }
  }

  // Update config so MqttTransport auto-connects
  saveConfig({
    mqtt: {
      ...config.mqtt,
      broker: `mqtt://localhost:${mqttPort}`,
      embedded: true,
    },
  });
}

export async function cmdBrokerStop(): Promise<void> {
  try {
    execSync("pm2 stop maw-broker 2>/dev/null", { stdio: "pipe" });
    console.log(`\x1b[32m✓\x1b[0m broker stopped`);
  } catch {
    console.log(`\x1b[90mbroker not running\x1b[0m`);
  }
}

export async function cmdBrokerStatus(): Promise<void> {
  const status = pm2BrokerStatus();
  console.log(`\x1b[36mmaw broker\x1b[0m\n`);

  if (status.online) {
    console.log(`  PM2:        \x1b[32monline\x1b[0m (pid ${status.pid}, uptime ${status.uptime})`);
  } else {
    console.log(`  PM2:        \x1b[90moffline\x1b[0m`);
  }

  const config = loadConfig();
  const mqttPort = config.mqtt?.port || 1883;
  const wsPort = config.mqtt?.wsPort || 9883;

  // Check TCP reachability
  for (const [label, port] of [["TCP", mqttPort], ["WS", wsPort]] as const) {
    try {
      const sock = await Bun.connect({ hostname: "localhost", port: port as number, socket: {
        data() {},
        open(s) { s.end(); },
        error() {},
        close() {},
      }});
      console.log(`  ${label} :${port}:  \x1b[32mreachable\x1b[0m`);
    } catch {
      console.log(`  ${label} :${port}:  \x1b[31munreachable\x1b[0m`);
    }
  }

  console.log(`  Config:     ${config.mqtt?.broker || "not set"}`);
  console.log();
}
