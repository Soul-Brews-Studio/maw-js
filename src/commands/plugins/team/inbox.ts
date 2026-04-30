import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { TEAMS_DIR } from "./team-helpers";

export type MessageType = "shutdown" | "progress" | "done" | "stuck" | "status";

export interface InboxMessage {
  type: MessageType;
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, unknown>;
  read?: boolean;
}

function inboxDir(teamName: string, agent: string): string {
  const dir = join(TEAMS_DIR, teamName, "inboxes", agent);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeInboxMessage(teamName: string, to: string, msg: Omit<InboxMessage, "timestamp">): string {
  const dir = inboxDir(teamName, to);
  const ts = Date.now();
  const full: InboxMessage = { ...msg, timestamp: ts };
  const filename = `${ts}-${msg.type}.json`;
  const tmpPath = join(dir, `.${filename}.tmp`);
  const finalPath = join(dir, filename);
  writeFileSync(tmpPath, JSON.stringify(full, null, 2));
  renameSync(tmpPath, finalPath);
  return finalPath;
}

export function readInbox(teamName: string, agent: string): InboxMessage[] {
  const dir = inboxDir(teamName, agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), "utf-8")) as InboxMessage; }
      catch { return null; }
    })
    .filter((m): m is InboxMessage => m !== null);
}

export function readUnread(teamName: string, agent: string): InboxMessage[] {
  return readInbox(teamName, agent).filter(m => !m.read);
}

export function markRead(teamName: string, agent: string): number {
  const dir = inboxDir(teamName, agent);
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith("."))) {
    try {
      const path = join(dir, f);
      const msg: InboxMessage = JSON.parse(readFileSync(path, "utf-8"));
      if (!msg.read) {
        msg.read = true;
        writeFileSync(path, JSON.stringify(msg, null, 2));
        count++;
      }
    } catch { /* skip corrupt */ }
  }
  return count;
}

export function sendProgress(teamName: string, from: string, status: string): string {
  return writeInboxMessage(teamName, "leader", { type: "progress", from, to: "leader", payload: { status } });
}

export function sendDone(teamName: string, from: string, summary: string): string {
  return writeInboxMessage(teamName, "leader", { type: "done", from, to: "leader", payload: { summary } });
}

export function sendStuck(teamName: string, from: string, reason: string): string {
  return writeInboxMessage(teamName, "leader", { type: "stuck", from, to: "leader", payload: { reason } });
}

export function sendShutdown(teamName: string, to: string, reason: string): string {
  return writeInboxMessage(teamName, to, { type: "shutdown", from: "leader", to, payload: { reason } });
}
