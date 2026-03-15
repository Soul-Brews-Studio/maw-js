import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const MAW_LOG_PATH = join(homedir(), ".oracle", "maw-log.jsonl");

export interface LogEntry {
  ts: string;
  from: string;
  to: string;
  msg: string;
  ch?: string;
  target?: string;
  host?: string;
  sid?: string;
}

/** Parse maw-log.jsonl — handles raw newlines and unescaped quotes in msg field. */
export function parseLog(): LogEntry[] {
  if (!existsSync(MAW_LOG_PATH)) return [];
  const raw = readFileSync(MAW_LOG_PATH, "utf-8");
  const entries: LogEntry[] = [];
  const chunks: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("{")) {
      chunks.push(line);
    } else if (chunks.length > 0 && line.trim()) {
      chunks[chunks.length - 1] += "\\n" + line;
    }
  }

  for (const chunk of chunks) {
    try {
      entries.push(JSON.parse(chunk));
    } catch {
      const msgStart = chunk.indexOf('"msg":"');
      if (msgStart === -1) continue;
      const contentStart = msgStart + 7;
      const endings = ['","ch"', '","target"', '","host"', '","sid"'];
      let contentEnd = -1;
      for (const end of endings) {
        const idx = chunk.lastIndexOf(end);
        if (idx > contentStart) { contentEnd = idx; break; }
      }
      if (contentEnd === -1) {
        const idx = chunk.lastIndexOf('"}');
        if (idx > contentStart) contentEnd = idx;
      }
      if (contentEnd === -1) continue;
      const msgContent = chunk.substring(contentStart, contentEnd);
      const escapedContent = msgContent.replace(/(?<!\\)"/g, '\\"');
      const fixed = chunk.substring(0, contentStart) + escapedContent + chunk.substring(contentEnd);
      try { entries.push(JSON.parse(fixed)); } catch {}
    }
  }
  return entries;
}

const KNOWN_NAMES: Record<string, string> = {
  neo: "neo-oracle", pulse: "pulse-oracle", hermes: "hermes-oracle",
  calliope: "calliope-oracle", nexus: "nexus-oracle", odin: "odin-oracle",
};

/** Resolve "unknown" sender from message signature */
export function resolveUnknown(entries: LogEntry[]): LogEntry[] {
  return entries.map(e => {
    if (e.from !== "unknown" || !e.msg) return e;
    const m = e.msg.match(/—\s+(\w+)\s*(?:\(Oracle|🖋)/) || e.msg.match(/—\s+(\w+)\s*$/);
    if (m) {
      const name = m[1].toLowerCase();
      if (KNOWN_NAMES[name]) return { ...e, from: KNOWN_NAMES[name] };
    }
    return e;
  });
}

/** Try to detect oracle identity from cli message signature */
function resolveCliSender(msg: string): string {
  if (!msg) return "nat";
  // "— Neo (Oracle, AI)" or "— Calliope 🖋️"
  const sigMatch = msg.match(/—\s+(\w+)\s*(?:\(Oracle|🖋)/);
  if (sigMatch) {
    const name = sigMatch[1].toLowerCase();
    if (KNOWN_NAMES[name]) return KNOWN_NAMES[name];
  }
  return "nat";
}

/** Deduplicate cli relay copies — keep unique cli entries, resolve sender */
export function dedup(entries: LogEntry[]): LogEntry[] {
  const oracleKeys = new Set<string>();
  for (const e of entries) {
    if (e.from !== "cli") oracleKeys.add(`${e.to}\0${e.msg}`);
  }
  return entries
    .filter(e => e.from !== "cli" || !oracleKeys.has(`${e.to}\0${e.msg}`))
    .map(e => e.from === "cli" ? { ...e, from: resolveCliSender(e.msg) } : e);
}

/** Full pipeline: parse → dedup → resolve */
export function readLog(): LogEntry[] {
  return resolveUnknown(dedup(parseLog()));
}
