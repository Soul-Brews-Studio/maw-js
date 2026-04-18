/**
 * cross-team-queue — fs walker + minimal YAML-subset frontmatter parser.
 *
 * VAULT_ROOT resolution: reads `MAW_VAULT_ROOT` env. No hardcoded default —
 * a missing env is surfaced via errors[], not silent-substituted. Per-oracle
 * layout: ${MAW_VAULT_ROOT}/<oracle>/ψ/memory/<oracle>/inbox/*.md.
 *
 * Frontmatter grammar (deliberately small — no js-yaml dep):
 *   key: value         → string
 *   key: [a, b, c]     → string[]
 *   key: true|false    → boolean
 *   key: 42            → number
 * Anything else → ParseError (never silent-dropped).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type {
  FrontmatterValue,
  InboxItem,
  ParseError,
  QueueFilter,
  QueueResponse,
  QueueStats,
} from "./types";

const FM_FENCE = /^---\s*$/;
const LIST_RE = /^\[\s*(.*?)\s*\]$/;

export function parseFrontmatter(
  raw: string,
  file: string,
): { data: Record<string, FrontmatterValue>; error?: ParseError } {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2 || !FM_FENCE.test(lines[0] ?? "")) {
    return { data: {}, error: { file, reason: "missing frontmatter" } };
  }
  const end = lines.slice(1).findIndex((l) => FM_FENCE.test(l));
  if (end === -1) {
    return { data: {}, error: { file, reason: "unterminated frontmatter" } };
  }
  const body = lines.slice(1, end + 1);
  const data: Record<string, FrontmatterValue> = {};
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      return { data, error: { file, reason: "malformed frontmatter" } };
    }
    const key = trimmed.slice(0, colon).trim();
    const rawVal = trimmed.slice(colon + 1).trim();
    if (!key) {
      return { data, error: { file, reason: "malformed frontmatter" } };
    }
    const listMatch = rawVal.match(LIST_RE);
    if (listMatch) {
      const inner = listMatch[1] ?? "";
      data[key] = inner === ""
        ? []
        : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (rawVal === "true" || rawVal === "false") {
      data[key] = rawVal === "true";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
      data[key] = Number(rawVal);
      continue;
    }
    data[key] = rawVal.replace(/^["']|["']$/g, "");
  }
  return { data };
}

function listOraclesInVault(vaultRoot: string): string[] {
  try {
    return readdirSync(vaultRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function inboxDir(vaultRoot: string, oracle: string): string {
  return join(vaultRoot, oracle, "ψ", "memory", oracle, "inbox");
}

function listInboxFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function matchesFilter(item: InboxItem, f: QueueFilter): boolean {
  if (f.recipient && item.recipient !== f.recipient) return false;
  if (f.team && item.team !== f.team) return false;
  if (f.type && item.type !== f.type) return false;
  if (typeof f.maxAgeHours === "number" && item.ageHours > f.maxAgeHours) return false;
  return true;
}

export function scanVault(filter: QueueFilter = {}, now: number = Date.now()): QueueResponse {
  const errors: ParseError[] = [];
  const items: InboxItem[] = [];
  const stats: QueueStats = { totalScanned: 0, totalReturned: 0, oracles: 0, byType: {} };

  const vaultRoot = process.env.MAW_VAULT_ROOT;
  if (!vaultRoot) {
    errors.push({ file: "<config>", reason: "MAW_VAULT_ROOT not set" });
    return { items, stats, errors };
  }
  if (!existsSync(vaultRoot)) {
    errors.push({ file: vaultRoot, reason: "vault root does not exist" });
    return { items, stats, errors };
  }

  const oracles = listOraclesInVault(vaultRoot);
  stats.oracles = oracles.length;

  for (const oracle of oracles) {
    const dir = inboxDir(vaultRoot, oracle);
    if (!existsSync(dir)) continue;
    for (const file of listInboxFiles(dir)) {
      stats.totalScanned++;
      let raw: string;
      let mtime: number;
      try {
        raw = readFileSync(file, "utf-8");
        mtime = statSync(file).mtimeMs;
      } catch (e: any) {
        errors.push({ file, reason: `read failed: ${e?.message ?? String(e)}` });
        continue;
      }
      const { data, error } = parseFrontmatter(raw, file);
      if (error) {
        errors.push(error);
        continue;
      }
      const ageHours = (now - mtime) / 3_600_000;
      const item: InboxItem = {
        file,
        oracle,
        recipient: typeof data.recipient === "string" ? data.recipient : undefined,
        team: typeof data.team === "string" ? data.team : undefined,
        type: typeof data.type === "string" ? data.type : undefined,
        subject: typeof data.subject === "string" ? data.subject : undefined,
        mtime,
        ageHours,
        frontmatter: data,
      };
      if (!matchesFilter(item, filter)) continue;
      items.push(item);
      if (item.type) stats.byType[item.type] = (stats.byType[item.type] ?? 0) + 1;
    }
  }

  items.sort((a, b) => b.mtime - a.mtime);
  stats.totalReturned = items.length;
  return { items, stats, errors };
}
