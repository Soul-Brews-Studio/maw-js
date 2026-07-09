import { dirname } from "path";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "fs";
import os from "os";
import { mawStatePath } from "../xdg";

export function auditFilePath(): string {
  return mawStatePath("audit.jsonl");
}

export interface AuditEntry {
  ts: string;
  cmd: string;
  args: string[];
  user: string;
  pid: number;
  result?: string;
}

const ATOMIC_APPEND_MAX_BYTES = 4096;

function appendAuditLineAtomic(filePath: string, line: string): void {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > ATOMIC_APPEND_MAX_BYTES) {
    throw new Error(`audit record too large for atomic append: ${bytes} bytes`);
  }
  const fd = openSync(filePath, "a");
  try {
    const written = writeSync(fd, line, undefined, "utf8");
    if (written !== bytes) throw new Error(`short audit append: ${written}/${bytes}`);
  } finally {
    closeSync(fd);
  }
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
    const filePath = auditFilePath();
    mkdirSync(dirname(filePath), { recursive: true });
    appendAuditLineAtomic(filePath, JSON.stringify(entry) + "\n");
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
  filePath = auditFilePath(),
): void {
  try {
    if (filePath === auditFilePath()) mkdirSync(dirname(filePath), { recursive: true });
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
  const filePath = auditFilePath();
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-count);
}
