/**
 * Discord Bridge — forward Oracle chat + deploy events to Discord webhook.
 *
 * Listens to mawLogListeners for chat messages and feedListeners for deploy events.
 * Uses PULSE_WEBHOOK_URL (same webhook as health alerts).
 *
 * Rate-limited: max 1 message per 3 seconds to avoid Discord rate limits.
 */

import type { FeedEvent } from "../lib/feed";

const WEBHOOK_URL = () => process.env.PULSE_WEBHOOK_URL;
const RATE_LIMIT_MS = 3000;
const MAX_QUEUE = 20;

// Agent color mapping for Discord embeds
const AGENT_COLORS: Record<string, number> = {
  "labubu-oracle": 0xe8b86d,  // gold
  "neo-oracle":    0x64b5f6,  // blue
  "pulse-oracle":  0x4caf50,  // green
  "echo-oracle":   0xba68c8,  // purple
  "nat":           0xff7043,  // orange (Boss)
};

interface QueueItem {
  payload: Record<string, unknown>;
  ts: number;
}

let queue: QueueItem[] = [];
let sending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  if (sending || queue.length === 0) return;
  sending = true;

  const url = WEBHOOK_URL();
  if (!url) { queue = []; sending = false; return; }

  const item = queue.shift()!;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.payload),
    });
  } catch (e) {
    console.error("[discord] send failed:", e);
  }

  sending = false;

  // Schedule next if queue has items
  if (queue.length > 0) {
    timer = setTimeout(flush, RATE_LIMIT_MS);
  }
}

function enqueue(payload: Record<string, unknown>) {
  if (!WEBHOOK_URL()) return;
  if (queue.length >= MAX_QUEUE) queue.shift(); // drop oldest
  queue.push({ payload, ts: Date.now() });
  if (!sending && !timer) {
    flush();
  } else if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, RATE_LIMIT_MS);
  }
}

/** Handle chat message from maw-log */
function onChat(entry: { ts: string; from: string; to: string; msg: string }) {
  // Skip system/cli messages, only forward actual oracle/human chat
  if (!entry.from || !entry.to || !entry.msg) return;
  if (entry.from === "cli" || entry.from === "system") return;

  const fromName = entry.from.replace(/-oracle$/, "");
  const toName = entry.to.replace(/-oracle$/, "");
  const color = AGENT_COLORS[entry.from] || 0x666666;
  const msgPreview = entry.msg.length > 300 ? entry.msg.slice(0, 297) + "..." : entry.msg;

  enqueue({
    embeds: [{
      color,
      author: { name: `${fromName} → ${toName}` },
      description: msgPreview,
      timestamp: entry.ts,
      footer: { text: "OracleNet Chat" },
    }],
  });
}

/** Handle feed event for deploy/session notifications */
function onFeed(event: FeedEvent) {
  // Deploy events
  if (event.event === "SubagentStart" && event.message?.includes("auto-restart")) {
    enqueue({
      embeds: [{
        color: 0xffaa00,
        title: `↻ Auto-restart: ${event.oracle}`,
        description: event.message,
        fields: [
          { name: "Project", value: event.project || "—", inline: true },
        ],
        timestamp: event.timestamp,
        footer: { text: "MAW Engine" },
      }],
    });
    return;
  }

  // Session start/stop for awareness
  if (event.event === "SessionStart") {
    enqueue({
      embeds: [{
        color: AGENT_COLORS[`${event.oracle}-oracle`] || 0x64b5f6,
        title: `▶ ${event.oracle} started`,
        description: event.project ? `Project: ${event.project}` : "Session started",
        timestamp: event.timestamp,
        footer: { text: "OracleNet" },
      }],
    });
    return;
  }

  if (event.event === "Stop") {
    const isCrash = event.message?.includes("crash");
    enqueue({
      embeds: [{
        color: isCrash ? 0xff4444 : 0x888888,
        title: `${isCrash ? "💥" : "⏹"} ${event.oracle} ${isCrash ? "crashed" : "stopped"}`,
        description: event.message || "Session ended",
        timestamp: event.timestamp,
        footer: { text: "OracleNet" },
      }],
    });
    return;
  }
}

/**
 * Start Discord bridge — attach to mawLogListeners and feedListeners.
 */
export function startDiscordBridge(
  mawLogListeners: Set<(entry: any) => void>,
  feedListeners: Set<(event: FeedEvent) => void>,
) {
  if (!WEBHOOK_URL()) {
    console.log("[discord] no PULSE_WEBHOOK_URL — bridge disabled");
    return;
  }

  mawLogListeners.add(onChat);
  feedListeners.add(onFeed);

  console.log("[discord] bridge started — chat + events → Discord");
}
