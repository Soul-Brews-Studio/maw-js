/**
 * Claude Code session JSONL transcript reader.
 *
 * Never loads the full file — tails via `tail -n N` to handle 10MB+ sessions.
 * Filters the noisy internal types (queue-operation, hook_*, skill_listing,
 * deferred_tools_delta, todo_reminder, last-prompt, system) down to the two
 * human-readable turns: `user` (top-level type) and `message` (assistant).
 */
import { hostExec } from "../transport/ssh";

export type Exec = (cmd: string) => Promise<string>;

export interface TranscriptEntry {
  ts: string;
  role: "user" | "assistant";
  text: string;
  tools?: string[];        // tool_use names when role=assistant
  sessionId?: string;
}

export interface TailOpts {
  tail?: number;           // how many JSONL lines to read from the end
  exec?: Exec;
  raw?: boolean;           // keep all types, don't filter
  maxTextLen?: number;
}

const DEFAULT_TAIL = 200;
const DEFAULT_MAX_TEXT = 4000;
const SUMMARY_TRUNCATE = 200;

export async function readTranscript(path: string, opts: TailOpts = {}): Promise<TranscriptEntry[]> {
  const tail = opts.tail ?? DEFAULT_TAIL;
  const exec = opts.exec || hostExec;
  const maxLen = opts.maxTextLen ?? DEFAULT_MAX_TEXT;
  const esc = path.replace(/'/g, "'\\''");
  const raw = await exec(`tail -n ${tail} '${esc}' 2>/dev/null || true`).catch(() => "");
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = safeParse(line);
    if (!parsed) continue;
    if (opts.raw) {
      const entry = toEntry(parsed, maxLen, true);
      if (entry) out.push(entry);
      continue;
    }
    const entry = toEntry(parsed, maxLen, false);
    if (entry) out.push(entry);
  }
  return out;
}

export async function tailLatestAssistant(path: string, exec?: Exec): Promise<string | null> {
  return findLatest(path, "assistant", exec);
}

export async function tailLatestUser(path: string, exec?: Exec): Promise<string | null> {
  return findLatest(path, "user", exec);
}

async function findLatest(path: string, role: "user" | "assistant", exec?: Exec): Promise<string | null> {
  const entries = await readTranscript(path, { tail: 400, exec });
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === role && entries[i].text) {
      return entries[i].text.slice(0, SUMMARY_TRUNCATE);
    }
  }
  return null;
}

function safeParse(line: string): any | null {
  try { return JSON.parse(line); } catch { return null; }
}

function toEntry(obj: any, maxLen: number, includeAll: boolean): TranscriptEntry | null {
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : undefined;

  // User message: top-level type="user" with message.content as string
  if (obj.type === "user" && obj.message?.role === "user") {
    if (!includeAll && isToolResultOnly(obj.message.content)) return null;
    const text = extractText(obj.message.content, maxLen);
    if (!text && !includeAll) return null;
    return { ts, role: "user", text, sessionId };
  }

  // Assistant message: top-level type="message" wrapping message.role="assistant"
  if (obj.type === "message" && obj.message?.role === "assistant") {
    const content = obj.message.content;
    const text = extractText(content, maxLen);
    const tools = extractToolNames(content);
    if (!text && !tools.length && !includeAll) return null;
    return { ts, role: "assistant", text, tools: tools.length ? tools : undefined, sessionId };
  }

  if (includeAll && obj.type && obj.message) {
    const role = obj.message?.role === "assistant" ? "assistant" : "user";
    return { ts, role, text: `[${obj.type}]`, sessionId };
  }
  return null;
}

function extractText(content: unknown, maxLen: number): string {
  if (typeof content === "string") return truncate(content, maxLen);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as any).type;
    if (t === "text" && typeof (item as any).text === "string") {
      parts.push((item as any).text);
    } else if (t === "tool_use" && typeof (item as any).name === "string") {
      parts.push(`[tool: ${(item as any).name}]`);
    } else if (t === "tool_result") {
      parts.push("[tool result]");
    }
  }
  return truncate(parts.join("\n").trim(), maxLen);
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(item =>
    item && typeof item === "object" && (item as any).type === "tool_result",
  );
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && (item as any).type === "tool_use" && typeof (item as any).name === "string") {
      names.push((item as any).name);
    }
  }
  return names;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
