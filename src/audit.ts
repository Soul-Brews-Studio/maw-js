import { join } from "path";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { CONFIG_DIR } from "./paths";

const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");

export function logAudit(command: string, args: string[], result?: string) {
  const entry: Record<string, unknown> = {
    ts: Date.now(),
    cmd: command,
    args,
  };
  if (result !== undefined) entry.result = result;
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

export function readAudit(count = 20): string[] {
  if (!existsSync(AUDIT_FILE)) return [];
  const lines = readFileSync(AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-count);
}
