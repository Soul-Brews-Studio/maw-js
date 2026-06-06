import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

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
}

export interface WakeInboxDrainDeps {
  existsSync?: typeof existsSync;
  readdirSync?: typeof readdirSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  markRead?: boolean;
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

export function formatWakeInboxPrompt(messages: WakeInboxMessage[]): string {
  if (!messages.length) return "";
  const sections = messages.map((msg, index) => [
    `### ${index + 1}. ${msg.filename}`,
    `from: ${msg.from || "unknown"}`,
    msg.timestamp ? `timestamp: ${msg.timestamp}` : "",
    "",
    msg.body,
  ].filter(Boolean).join("\n"));
  return [
    "## Unread ψ/inbox messages",
    "These messages were mechanically drained by `maw wake`; acknowledge or act on them before continuing.",
    "",
    ...sections,
  ].join("\n\n");
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
  const markRead = deps.markRead ?? true;
  const inboxDir = join(repoPath, "ψ", "inbox");
  if (!fsExists(inboxDir)) return { count: 0, prompt: "", messages: [] };

  const messages: WakeInboxMessage[] = [];
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
    messages.push({
      path,
      filename,
      from: parsed.meta.from ?? "",
      timestamp: parsed.meta.timestamp ?? "",
      body: parsed.body,
    });
    if (markRead) {
      try {
        fsWriteFile(path, markFrontmatterRead(raw, new Date().toISOString()));
      } catch {
        // Draining is best-effort: a read-only inbox should not prevent wake.
      }
    }
  }

  return { count: messages.length, messages, prompt: formatWakeInboxPrompt(messages) };
}
