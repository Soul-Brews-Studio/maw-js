import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { MawConfig } from "../../config/types";
import { isClaudeLikeEngine } from "../../core/engine/is-claude-like";

export interface WakeInboxMessage {
  path: string;
  filename: string;
  from: string;
  timestamp: string;
  body: string;
}

export interface WakeInboxDrainResult {
  count: number;
  prompt: string;
  messages: WakeInboxMessage[];
  omittedCount: number;
  byteBudget: number;
}

export interface WakeInboxDrainDeps {
  existsSync?: typeof existsSync;
  readdirSync?: typeof readdirSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  markRead?: boolean;
  byteBudget?: number;
  engine?: string;
  config?: Partial<MawConfig>;
}

export const DEFAULT_WAKE_INBOX_BYTE_BUDGET = 64 * 1024;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string; frontmatter: string | null } {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw.trim(), frontmatter: null };
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: raw.trim(), frontmatter: null };
  const frontmatter = raw.slice(0, end + "\n---".length);
  const body = raw.slice(end + "\n---".length).replace(/^\s*\n/, "").trim();
  const meta: Record<string, string> = {};
  for (const line of frontmatter.slice(4, -4).split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
  }
  return { meta, body, frontmatter };
}

function isUnread(meta: Record<string, string>): boolean {
  return (meta.read ?? "false").trim().toLowerCase() === "false";
}

function markFrontmatterRead(raw: string, timestamp: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return raw;
  let fm = raw.slice(0, end + "\n---".length);
  if (/^read:\s*false\s*$/im.test(fm)) fm = fm.replace(/^read:\s*false\s*$/im, "read: true");
  else if (!/^read:/im.test(fm)) fm = fm.replace(/\n---$/, "\nread: true\n---");
  if (!/^readAt:/im.test(fm)) fm = fm.replace(/\n---$/, `\nreadAt: ${timestamp}\n---`);
  return fm + raw.slice(end + "\n---".length);
}

export function formatWakeInboxPrompt(messages: WakeInboxMessage[], omittedCount = 0): string {
  const unreadCount = messages.length + omittedCount;
  if (unreadCount <= 0) return "";
  return `You have ${unreadCount} unread messages in inbox. Run maw inbox --unread to review.\n`;
}

export function mergeWakeInboxPrompt(existingPrompt: string | undefined, inboxPrompt: string): string | undefined {
  if (!inboxPrompt.trim()) return existingPrompt;
  if (!existingPrompt?.trim()) return inboxPrompt;
  return `${existingPrompt.trim()}\n\n${inboxPrompt}`;
}

export function drainWakeInbox(repoPath: string, deps: WakeInboxDrainDeps = {}): WakeInboxDrainResult {
  const fsExists = deps.existsSync ?? existsSync;
  const fsReadDir = deps.readdirSync ?? readdirSync;
  const fsReadFile = deps.readFileSync ?? readFileSync;
  const fsWriteFile = deps.writeFileSync ?? writeFileSync;
  const markRead = deps.markRead ?? false;
  const byteBudget = Math.max(0, Math.floor(deps.byteBudget ?? DEFAULT_WAKE_INBOX_BYTE_BUDGET));
  const engine = deps.engine;
  if (engine !== undefined && !isClaudeLikeEngine(engine, deps.config ?? {})) {
    return { count: 0, prompt: "", messages: [], omittedCount: 0, byteBudget };
  }

  const inboxDir = join(repoPath, "ψ", "inbox");
  if (!fsExists(inboxDir)) return { count: 0, prompt: "", messages: [], omittedCount: 0, byteBudget };

  const messages: WakeInboxMessage[] = [];
  let omittedCount = 0;
  for (const filename of fsReadDir(inboxDir).filter((name) => name.endsWith(".md")).sort()) {
    const path = join(inboxDir, filename);
    let raw: string;
    try {
      raw = fsReadFile(path, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!isUnread(parsed.meta)) continue;
    const message = {
      path,
      filename,
      from: parsed.meta.from ?? "",
      timestamp: parsed.meta.timestamp ?? "",
      body: parsed.body,
    };
    messages.push(message);
    if (markRead) {
      try {
        fsWriteFile(path, markFrontmatterRead(raw, new Date().toISOString()));
      } catch {
        // Draining is best-effort: a read-only inbox should not prevent wake.
      }
    }
  }

  let prompt = formatWakeInboxPrompt(messages, omittedCount);
  if (utf8Bytes(prompt) > byteBudget) prompt = "";
  return { count: messages.length, messages, omittedCount, byteBudget, prompt };
}
