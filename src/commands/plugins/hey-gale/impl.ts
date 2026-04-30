/**
 * hey-gale — shortcut for messaging Gale.
 *
 * Delivery intentionally delegates to cmdSend so this plugin inherits the same
 * transport, ACL, hooks, logging, and federation behavior as `maw hey`.
 */

import { loadConfig, type MawConfig } from "../../../config";
import { cmdSend } from "../../shared/comm";
import { cmdCapture } from "../capture/impl";

export interface HeyGaleOpts {
  message: string;
  wait?: boolean;
}

const GALE_KEYS = ["gale", "gale-oracle", "01-gale"];
const DEFAULT_GALE_TARGET = "wind:gale";

export async function cmdHeyGale(opts: HeyGaleOpts): Promise<void> {
  const message = opts.message.trim();
  if (!message) throw new Error("usage: maw hey-gale <message> [--wait]");

  const target = resolveGaleTarget();
  await cmdSend(target, message);
  console.log(`delivered to gale: ${message}`);

  if (opts.wait) {
    await Bun.sleep(1500);
    await captureGaleResponse(target);
  }
}

export function parseHeyGaleArgs(args: string[]): HeyGaleOpts {
  let wait = false;
  const messageParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--wait") {
      wait = true;
      continue;
    }
    if (arg === "--") {
      messageParts.push(...args.slice(i + 1));
      break;
    }
    messageParts.push(arg);
  }

  const message = messageParts.join(" ").trim();
  if (!message) throw new Error("usage: maw hey-gale <message> [--wait]");

  return { message, wait };
}

export function resolveGaleTarget(config: MawConfig = loadConfig()): string {
  const fromAgents = resolveFromAgents(config);
  if (fromAgents) return fromAgents;

  if (hasConfiguredGaleSession(config)) {
    return `${config.node ?? "local"}:gale`;
  }

  return DEFAULT_GALE_TARGET;
}

async function captureGaleResponse(target: string): Promise<void> {
  try {
    await cmdCapture(target, { lines: 40 });
  } catch (e: any) {
    console.error(`wait capture failed for ${target}: ${e?.message || e}`);
  }
}

function resolveFromAgents(config: MawConfig): string | null {
  const agents = config.agents ?? {};
  for (const key of GALE_KEYS) {
    const node = agents[key];
    if (!node) continue;
    return `${normalizeNode(node, config)}:gale`;
  }
  return null;
}

function hasConfiguredGaleSession(config: MawConfig): boolean {
  const sessions = config.sessions ?? {};
  return GALE_KEYS.some((key) => Boolean(sessions[key]));
}

function normalizeNode(node: string, config: MawConfig): string {
  if (node === "local") return config.node ?? "local";
  return node;
}
