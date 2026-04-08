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
import { listSessions, findWindow, sendKeys, capture } from "../ssh";
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

  // Capture "before" state
  const beforeCapture = await capture(window).catch(() => "");

  // Send to oracle
  const notification = `💬 from Discord (Boss): "${msg}"`;
  await sendKeys(window, notification);

  // React to show dispatch
  await message.react("📨").catch(() => {});

  // Wait and capture response (poll for 15 seconds)
  let response = "";
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const afterCapture = await capture(window).catch(() => "");
    if (afterCapture && afterCapture !== beforeCapture) {
      // Extract new content (last 20 lines that weren't in before)
      const beforeLines = new Set(beforeCapture.split("\n"));
      const newLines = afterCapture.split("\n").filter(l => !beforeLines.has(l) && l.trim());
      if (newLines.length > 0) {
        response = newLines.slice(-20).join("\n");
        break;
      }
    }
  }

  if (response) {
    // Truncate for Discord (max 2000 chars)
    const truncated = response.length > 1800 ? response.slice(0, 1797) + "..." : response;
    const color = COLORS[oracleName] || 0x666666;

    await message.reply({
      embeds: [{
        color,
        author: { name: `${oracleName} responded` },
        description: "```\n" + truncated + "\n```",
        footer: { text: "OracleNet via MAW" },
      }],
    });

    // Log response
    logToMawLog(oracleName + "-oracle", "nat-discord", response.slice(0, 500));
  } else {
    await message.reply(`Dispatched to **${oracleName}**. No response captured yet — Oracle may still be processing.`);
  }
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

  client.on("ready", () => {
    console.log(`[discord-bot] logged in as ${client!.user?.tag}`);
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
