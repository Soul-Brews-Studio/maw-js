import { appendFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths";

const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

export interface AuditEntry {
  ts: string;
  cmd: string;
  args: string[];
  user: string;
  pid: number;
}

/** Append a structured audit log entry to ~/.config/maw/audit.jsonl */
export function logAudit(cmd: string, args: string[]): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    cmd,
    args,
    user: process.env.USER || process.env.LOGNAME || "unknown",
    pid: process.pid,
  };
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Silent fail — audit should never break the CLI
  }
}
