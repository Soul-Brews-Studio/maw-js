/**
 * Oracle Feed Parser — Pure functions, zero dependencies.
 * Works in both server (Bun) and browser (via Vite).
 *
 * Feed log format:
 *   TIMESTAMP | ORACLE | HOST | EVENT | PROJECT | SESSION_ID » MESSAGE
 */

export type FeedEventType =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "SubagentStart"
  | "SubagentStop"
  | "TaskCompleted"
  | "SessionEnd"
  | "SessionStart"
  | "Stop"
  | "Notification"
  // Message lifecycle (hooks v2)
  | "MessageSend"
  | "MessageDeliver"
  | "MessageFail"
  // Plugin lifecycle
  | "PluginHook"
  | "PluginFilter"
  | "PluginLoad"
  | "PluginError";

export interface FeedEvent {
  timestamp: string;
  oracle: string;
  host: string;
  event: FeedEventType;
  project: string;
  sessionId: string;
  message: string;
  ts: number;
}

/**
 * Parse a single feed.log line into a FeedEvent.
 * Returns null if the line is malformed.
 */
export function parseLine(line: string): FeedEvent | null {
  if (!line || !line.includes(" | ")) return null;

  const parts = line.split(" | ").map((s) => s.trim());
  if (parts.length < 5) return null;

  const timestamp = parts[0];
  const oracle = parts[1];
  const host = parts[2];
  const event = parts[3] as FeedEventType;
  const project = parts[4];

  // Session ID and message are separated by » in the remaining part
  const rest = parts.slice(5).join(" | ");
  let sessionId = "";
  let message = "";

  const guiIdx = rest.indexOf(" » ");
  if (guiIdx !== -1) {
    sessionId = rest.slice(0, guiIdx).trim();
    message = rest.slice(guiIdx + 3).trim();
  } else {
    // Fallback: treat entire rest as sessionId (no message)
    sessionId = rest.trim();
  }

  // Parse timestamp to epoch ms
  const ts = new Date(timestamp.replace(" ", "T") + "+07:00").getTime();
  if (isNaN(ts)) return null;

  return { timestamp, oracle, host, event, project, sessionId, message, ts };
}

/**
 * Get active oracles from a list of events within a time window.
 * Returns Map of oracle name → most recent FeedEvent.
 */
export function activeOracles(
  events: FeedEvent[],
  windowMs = 5 * 60_000,
): Map<string, FeedEvent> {
  const cutoff = Date.now() - windowMs;
  const map = new Map<string, FeedEvent>();

  for (const e of events) {
    if (e.ts < cutoff) continue;
    const prev = map.get(e.oracle);
    if (!prev || e.ts > prev.ts) map.set(e.oracle, e);
  }

  return map;
}

/** Tool name extraction from PreToolUse messages */
const TOOL_ICONS: Record<string, string> = {
  Bash: "⚡",
  Read: "📖",
  Edit: "✏️",
  Write: "📝",
  Grep: "🔍",
  Glob: "📂",
  Agent: "🤖",
  WebFetch: "🌐",
  WebSearch: "🔎",
};

/**
 * Human-readable one-liner for what the oracle is doing.
 */
export function describeActivity(event: FeedEvent): string {
  switch (event.event) {
    case "PreToolUse": {
      // Message format: "ToolName: details..." or "ToolName ✓"
      const colonIdx = event.message.indexOf(":");
      const tool =
        colonIdx > 0 ? event.message.slice(0, colonIdx).trim() : event.message.split(" ")[0];
      const icon = TOOL_ICONS[tool] || "🔧";
      const detail = colonIdx > 0 ? event.message.slice(colonIdx + 1).trim() : "";
      const short = detail.length > 60 ? detail.slice(0, 57) + "..." : detail;
      return short ? `${icon} ${tool}: ${short}` : `${icon} ${tool}`;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const ok = event.event === "PostToolUse";
      const tool = event.message.replace(/ [✓✗].*$/, "").trim() || "Tool";
      return ok ? `✓ ${tool} done` : `✗ ${tool} failed`;
    }
    case "UserPromptSubmit": {
      const short =
        event.message.length > 60 ? event.message.slice(0, 57) + "..." : event.message;
      return `💬 ${short || "New prompt"}`;
    }
    case "SubagentStart":
      return `🤖 Subagent started`;
    case "SubagentStop":
      return `🤖 Subagent done`;
    case "SessionStart":
      return `🟢 Session started`;
    case "SessionEnd":
      return `⏹ Session ended`;
    case "Stop": {
      const short =
        event.message.length > 60 ? event.message.slice(0, 57) + "..." : event.message;
      return `⏹ ${short || "Stopped"}`;
    }
    case "Notification":
      return `🔔 ${event.message || "Notification"}`;
    default:
      return event.message || event.event;
  }
}
