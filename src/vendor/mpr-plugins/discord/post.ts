import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { decryptToken, LEGACY_STATE_DIR_ROOT } from "./lib";

export async function getBotToken(bot: string): Promise<string> {
  // 1. Try decrypting from pass
  const passToken = await decryptToken(`${bot}-token`);
  if (passToken) return passToken;

  // 2. Try loading from state directory (.env file)
  const paths = [
    join(LEGACY_STATE_DIR_ROOT, `discord-${bot}`, ".env"),
    join(LEGACY_STATE_DIR_ROOT, bot, ".env"),
    join("/root/.claude/channels", `discord-${bot}`, ".env"),
    join("/root/.claude/channels", bot, ".env"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("DISCORD_BOT_TOKEN=")) {
          const token = trimmed.split("=", 2)[1];
          if (token) return token;
        }
      }
    }
  }

  throw new Error(`Could not find Discord bot token for bot: ${bot}`);
}

export interface DiscordMessageReference {
  message_id: string;
  channel_id?: string;
  guild_id?: string;
  fail_if_not_exists?: boolean;
}

export interface DiscordMessagePayload {
  content: string;
  message_reference?: DiscordMessageReference;
}

export interface DiscordMessageResponse {
  id: string;
  channel_id: string;
  content: string;
}

export async function cmdPost(bot: string, channelId: string, text: string, replyTo?: string): Promise<string> {
  const token = await getBotToken(bot);
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  
  const payload: DiscordMessagePayload = {
    content: text,
  };
  
  if (replyTo) {
    payload.message_reference = {
      message_id: replyTo,
      channel_id: channelId,
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "MawDiscordPlugin/1.0"
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Discord API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as DiscordMessageResponse;
  return data.id;
}
