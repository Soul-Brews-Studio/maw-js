/**
 * Discord Bot — bidirectional Oracle↔Discord communication.
 *
 * Receives messages from a Discord channel, dispatches to Oracle tmux,
 * captures response, posts back to Discord.
 *
 * Command syntax: !maw <oracle> <message>
 * Example: !maw neo do a git status
 *
 * Requires: DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID env vars.
 */

import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";
import { listSessions, findWindow, sendKeys } from "../ssh";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";

const BOT_TOKEN = () => process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = () => process.env.DISCORD_CHANNEL_ID;
const MAW_LOG_DIR = join(homedir(), ".oracle");
const MAW_LOG_FILE = join(MAW_LOG_DIR, "maw-log.jsonl");

// Agent colors for embeds
const COLORS: Record<string, number> = {
  labubu: 0xe8b86d, neo: 0x64b5f6, pulse: 0x4caf50, echo: 0xba68c8,
};

let client: Client | null = null;
let responseChannel: TextChannel | null = null;

// Track pending dispatches — oracle → timestamp
const pendingDispatches = new Map<string, number>();

function logToMawLog(from: string, to: string, msg: string) {
  try {
    mkdirSync(MAW_LOG_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), from, to, msg, host: hostname(), ch: "discord" };
    appendFileSync(MAW_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

async function handleCommand(message: Message) {
  const content = message.content.trim();

  // Parse: !maw <oracle> <message>
  const match = content.match(/^!maw\s+(\S+)\s+(.+)$/s);
  if (!match) {
    await message.reply("Usage: `!maw <oracle> <message>`\nExample: `!maw neo do a git status`");
    return;
  }

  const [, target, msg] = match;
  const oracleName = target.includes("-oracle") ? target : target;
  const tmuxTarget = `${oracleName}:${oracleName}-oracle`;

  // Find oracle tmux window
  const sessions = await listSessions();
  const window = findWindow(sessions, oracleName + "-oracle") || findWindow(sessions, oracleName);

  if (!window) {
    await message.reply(`Oracle **${oracleName}** not found in tmux. Available: ${sessions.map(s => s.name).join(", ")}`);
    return;
  }

  // Log inbound
  logToMawLog("nat-discord", oracleName + "-oracle", msg);

  // Track this dispatch so we can forward the response
  pendingDispatches.set(oracleName + "-oracle", Date.now());
  // Auto-expire after 5 minutes
  setTimeout(() => pendingDispatches.delete(oracleName + "-oracle"), 5 * 60 * 1000);

  // Send to oracle — include instruction to reply via maw talk-to
  const notification = `💬 from Discord (Boss): "${msg}"\n→ ตอบกลับด้วย: maw talk-to nat-discord "${msg.length > 50 ? "คำตอบ" : "reply"}"`;
  await sendKeys(window, notification);

  const color = COLORS[oracleName] || 0x666666;
  await message.reply({
    embeds: [{
      color,
      author: { name: `📨 → ${oracleName}` },
      description: `"${msg.length > 200 ? msg.slice(0, 197) + "..." : msg}"`,
      footer: { text: "Waiting for Oracle response..." },
    }],
  });
}

/**
 * Start Discord bot — login and listen for messages.
 */
export function startDiscordBot(
  mawLogListeners: Set<(entry: any) => void>,
  feedListeners: Set<(event: any) => void>,
) {
  const token = BOT_TOKEN();
  const channelId = CHANNEL_ID();

  if (!token) {
    console.log("[discord-bot] no DISCORD_BOT_TOKEN — bot disabled");
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("ready", async () => {
    console.log(`[discord-bot] logged in as ${client!.user?.tag}`);
    // Cache the response channel
    if (channelId) {
      try {
        const ch = await client!.channels.fetch(channelId);
        if (ch && "send" in ch) responseChannel = ch as TextChannel;
      } catch {}
    }
  });

  // Listen for Oracle responses via maw-log and forward to Discord
  mawLogListeners.add((entry: any) => {
    if (!responseChannel) return;
    if (!entry.from || !entry.to || !entry.msg) return;
    // Only forward messages FROM oracles (not from nat/cli/system)
    if (!entry.from.includes("-oracle")) return;
    // Skip messages we sent ourselves (from discord bot)
    if (entry.ch === "discord") return;
    // Only forward if this oracle had a pending dispatch
    if (!pendingDispatches.has(entry.from)) return;

    const oracleName = entry.from.replace(/-oracle$/, "");
    const color = COLORS[oracleName] || 0x666666;
    const msgPreview = entry.msg.length > 1800 ? entry.msg.slice(0, 1797) + "..." : entry.msg;

    responseChannel.send({
      embeds: [{
        color,
        author: { name: `${oracleName} responded` },
        description: msgPreview,
        footer: { text: "OracleNet" },
      }],
    }).catch(() => {});

    // Clear pending
    pendingDispatches.delete(entry.from);
  });

  client.on("messageCreate", async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    // Only respond in configured channel (if set)
    if (channelId && message.channelId !== channelId) return;
    // Only respond to !maw commands
    if (!message.content.startsWith("!maw")) return;

    try {
      await handleCommand(message);
    } catch (e) {
      console.error("[discord-bot] command error:", e);
      await message.reply("Error processing command").catch(() => {});
    }
  });

  client.login(token).catch((e) => {
    console.error("[discord-bot] login failed:", e);
  });
}
