import { join } from "path";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { CONFIG_DIR } from "./paths";

const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

export interface AuditEntry {
  ts: string;
  cmd: string;
  args: string[];
  user: string;
  pid: number;
  result?: string;
}

/** Append a structured audit log entry to ~/.config/maw/audit.jsonl */
export function logAudit(cmd: string, args: string[], result?: string): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    cmd,
    args,
    user: process.env.USER || process.env.LOGNAME || "unknown",
    pid: process.pid,
  };
  if (result !== undefined) (entry as any).result = result;
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Silent fail — audit should never break the CLI
  }
}

export function readAudit(count = 20): string[] {
  if (!existsSync(AUDIT_FILE)) return [];
  const lines = readFileSync(AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-count);
}
