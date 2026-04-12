/**
 * Nanoclaw bridge — sends messages from maw-js through nanoclaw to any channel.
 *
 * POST nanoclaw:PORT/send → nanoclaw routes to Telegram/Discord/etc.
 * Config: maw.config.json → nanoclaw: { url, channels: { nat: "tg:123456789" } }
 *
 * Built by white:mawjs-oracle as the maw-js side of the nanoclaw maw channel
 * plugin (built by oracle-world:mawjs). See #201 collab.
 */

import { loadConfig } from "../config";
import { curlFetch } from "../curl-fetch";

interface NanoclawConfig {
  url: string;               // e.g. "http://localhost:3001"
  channels: Record<string, string>;  // e.g. { nat: "tg:123456789", dev: "dc:987654321" }
}

/** Resolve a "telegram:nat" or "tg:12345" target to a nanoclaw JID */
export function resolveNanoclawJid(target: string): { jid: string; url: string } | null {
  const config = loadConfig();
  const nc = (config as any).nanoclaw as NanoclawConfig | undefined;
  if (!nc?.url) return null;

  // Direct JID pass-through (tg:12345, dc:98765)
  if (/^(tg|dc|sl|wa|gm|mx):/.test(target)) {
    return { jid: target, url: nc.url };
  }

  // Channel alias: "telegram:nat" → lookup in config.nanoclaw.channels.nat
  if (target.includes(":")) {
    const [, alias] = target.split(":", 2);
    const jid = nc.channels?.[alias];
    if (jid) return { jid, url: nc.url };
  }

  // Bare alias: "nat" → lookup directly
  const jid = nc.channels?.[target];
  if (jid) return { jid, url: nc.url };

  return null;
}

/** Send a message through nanoclaw to any channel */
export async function sendViaNanoclaw(jid: string, text: string, url: string): Promise<boolean> {
  try {
    const res = await curlFetch(`${url}/send`, {
      method: "POST",
      body: JSON.stringify({ jid, text }),
    });
    return res.ok && res.data?.ok;
  } catch {
    return false;
  }
}
