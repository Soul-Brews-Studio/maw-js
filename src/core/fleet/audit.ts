import { dirname } from "path";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import os from "os";
import { mawStatePath } from "../xdg";

const AUDIT_FILE = mawStatePath("audit.jsonl");

export interface AuditEntry {
  ts: string;
  cmd: string;
  args: string[];
  user: string;
  pid: number;
  result?: string;
}

/** Append a structured audit log entry to maw's runtime state audit log. */
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
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Silent fail — audit should never break the CLI
  }
}

export interface AnomalyEntry {
  ts: string;
  kind: "anomaly";
  event: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  user: string;
  pid: number;
  cwd: string;
  tty: string | null;
}

/**
 * Append a structured anomaly entry to maw's runtime state audit log.
 * Optional `filePath` overrides the default path (for test isolation).
 */
export function logAnomaly(
  event: string,
  data: { input?: Record<string, unknown>; context?: Record<string, unknown> },
  filePath = AUDIT_FILE,
): void {
  try {
    if (filePath === AUDIT_FILE) mkdirSync(dirname(filePath), { recursive: true });
    const entry: AnomalyEntry = {
      ts: new Date().toISOString(),
      kind: "anomaly",
      event,
      input: data.input ?? {},
      context: data.context ?? {},
      user: os.userInfo().username,
      pid: process.pid,
      cwd: process.cwd(),
      tty: process.stdin.isTTY ? (process.env.TTY ?? null) : null,
    };
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
  } catch { /* silent */ }
}

export function readAudit(count = 20): string[] {
  if (!existsSync(AUDIT_FILE)) return [];
  const lines = readFileSync(AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-count);
}
