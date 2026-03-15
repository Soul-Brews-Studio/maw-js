import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const CONFIG_PATH = join(homedir(), ".oracle", "maw.hooks.json");

interface HooksConfig {
  hooks?: Record<string, string>;
}

let configCache: HooksConfig | null = null;

async function loadConfig(): Promise<HooksConfig> {
  if (configCache) return configCache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    configCache = JSON.parse(raw);
    return configCache!;
  } catch {
    configCache = {};
    return configCache;
  }
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function inferCaller(): string {
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  const cwd = process.cwd();
  const match = cwd.match(/([^/]+)-oracle/);
  if (match) return match[1];
  return "unknown";
}

export async function runHook(
  event: string,
  data: { from?: string; to: string; message: string; channel?: string },
) {
  const config = await loadConfig();
  const script = config.hooks?.[event];
  if (!script) return;

  const env = {
    ...process.env,
    MAW_EVENT: event,
    MAW_TIMESTAMP: new Date().toISOString(),
    MAW_FROM: data.from || inferCaller(),
    MAW_TO: data.to,
    MAW_MESSAGE: data.message,
    MAW_CHANNEL: data.channel || "hey",
  };

  try {
    const child = spawn("sh", ["-c", expandPath(script)], {
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Never fail the main command because a hook broke
  }
}
