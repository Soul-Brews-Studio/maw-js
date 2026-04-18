// cross-team-queue-scan.ts — filesystem scan + frontmatter parse
// Author: FORGE Oracle — 2026-04-18 (ADR-002 Day 2)
//
// Scans `~/david-oracle/ψ/memory/<oracle>/inbox/*.md` (central vault per
// Patch 6). Returns parsed items + accumulated errors. Never drops an item
// silently — parse failures surface in errors[] (Principle 2).
//
// Hand-rolled frontmatter parser (no new runtime dep). Covers the subset
// actually used in inbox files: `key: value`, `key: "value"`, `key: [a, b]`,
// and multi-line indented lists (`key:\n  - item\n  - item`).

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import type {
  CrossTeamQueueItem,
  CrossTeamQueueParseError,
  TeamName,
} from "../shared/cross-team-queue.types";
import { TEAM_ROSTER } from "../shared/cross-team-queue.types";

// ─── VAULT_ROOT contract ─────────────────────────────────────────────────
//
// Scan root is `~/david-oracle/ψ/memory/` (central vault per Patch 6).
// `relPath` on every item is path RELATIVE TO THIS ROOT — produces e.g.
//   "helm/inbox/2026-04-18_forge-morning-status.md"
// (not "memory/helm/inbox/…" and not "ψ/memory/helm/inbox/…"). Documented
// once here; test file asserts it (answers NEXUS G3 from peer review).

function resolveVaultRoot(): string {
  // Resolved lazily at call time so env overrides set after module load
  // (e.g., in test beforeAll hooks) take effect.
  return process.env.CTQ_VAULT_ROOT ?? join(homedir(), "david-oracle", "ψ", "memory");
}

// ─── Frontmatter parser (inbox subset) ──────────────────────────────────

interface ParsedFrontmatter {
  [key: string]: string | string[] | boolean | number;
}

function parseFrontmatter(raw: string): { fm: ParsedFrontmatter; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  const [, block, body] = match;
  const fm: ParsedFrontmatter = {};
  const lines = block.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let value = kv[2].trim();

    // Multi-line indented list: `key:\n  - item\n  - item`
    if (value === "") {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const item = next.match(/^\s+-\s+(.+)$/);
        if (!item) break;
        items.push(stripQuotes(item[1].trim()));
        i++;
      }
      fm[key] = items;
      continue;
    }

    // Inline array: `key: [a, b, c]`
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      i++;
      continue;
    }

    // Scalar
    fm[key] = stripQuotes(value);
    i++;
  }

  return { fm, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Normalizers ────────────────────────────────────────────────────────

function normalizeOracleName(raw: string): string {
  // Strip -oracle suffix, lowercase, trim
  return raw.toLowerCase().trim().replace(/-oracle$/, "");
}

function teamOf(oracleName: string): TeamName | "unknown" {
  const name = normalizeOracleName(oracleName);
  for (const [team, members] of Object.entries(TEAM_ROSTER) as [TeamName, readonly string[]][]) {
    if (members.includes(name)) return team;
  }
  return "unknown";
}

function parseActionRequired(raw: unknown): { actionRequired: boolean; actionHint: string | null } {
  if (typeof raw !== "string") return { actionRequired: false, actionHint: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { actionRequired: false, actionHint: null };

  // Word-boundary match on yes/no so `none` isn't mis-classified as `no`.
  // Probe 2 (VELA 2026-04-18): unusual values like `review`, `none` must NOT
  // silently collapse to false — Principle 2 (never silently drop).
  const match = trimmed.match(/^(yes|no)\b(?:\s*\(([^)]*)\))?\s*(.*)$/i);
  if (!match) {
    // Unknown value — surface as actionRequired:true with raw as hint so
    // Leo sees it in the queue rather than losing it silently.
    return { actionRequired: true, actionHint: trimmed };
  }
  const yes = match[1].toLowerCase() === "yes";
  const parenReason = match[2]?.trim() || null;
  const trailing = match[3]?.trim() || null;
  const hint = parenReason || (trailing && trailing !== "" ? trailing : null);
  return { actionRequired: yes, actionHint: hint };
}

function normalizePriority(fm: ParsedFrontmatter): "high" | "medium" | "low" {
  const raw = typeof fm.priority === "string" ? fm.priority.toLowerCase().trim() : "";
  if (raw === "high" || raw === "urgent" || raw === "critical") return "high";
  if (raw === "low") return "low";
  // Check tags for priority hints
  const tags = asArray(fm.tags);
  if (tags.some((t) => /urgent|critical/i.test(t))) return "high";
  if (tags.some((t) => /low.priority/i.test(t))) return "low";
  return "medium";
}

function normalizeConfidence(fm: ParsedFrontmatter): "high" | "medium" | "low" {
  const raw = typeof fm.confidence === "string" ? fm.confidence.toLowerCase().trim() : "";
  if (raw === "high") return "high";
  if (raw === "low") return "low";
  return "medium"; // default per type docstring
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

// ─── Title + preview extraction ─────────────────────────────────────────

function extractTitle(body: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 200);
  const firstPara = body.trim().split(/\r?\n\r?\n/)[0] ?? "";
  return firstPara.slice(0, 120).replace(/\s+/g, " ").trim();
}

function extractPreview(body: string): string {
  // Skip H1 line, take next ~200 chars of actual prose
  const withoutH1 = body.replace(/^#\s+.+$/m, "").trim();
  return withoutH1.slice(0, 200).replace(/\s+/g, " ").trim();
}

// ─── Age computation (G4 — max of date + mtime) ─────────────────────────

function computeAgeHours(dateStr: string, mtime: number, scannedAt: number): number {
  const parsed = Date.parse(dateStr);
  const dateMs = Number.isNaN(parsed) ? 0 : parsed;
  // G4: use max(frontmatter-date, mtime) so post-dated frontmatter never
  // produces negative ages AND stale mtime never masks a fresh edit.
  const effective = Math.max(dateMs, mtime);
  if (effective === 0) return 0;
  return Math.max(0, (scannedAt - effective) / (60 * 60 * 1000));
}

// ─── Main scan ──────────────────────────────────────────────────────────

export interface ScanResult {
  items: CrossTeamQueueItem[];
  errors: CrossTeamQueueParseError[];
  scannedFileCount: number;
  emptyInboxes: string[];
  scannedAt: number;
}

export function scanCrossTeamQueue(vaultRoot?: string): ScanResult {
  const root = vaultRoot ?? resolveVaultRoot();
  const scannedAt = Date.now();
  const items: CrossTeamQueueItem[] = [];
  const errors: CrossTeamQueueParseError[] = [];
  const emptyInboxes: string[] = [];
  let scannedFileCount = 0;

  let oracleDirs: string[];
  try {
    oracleDirs = readdirSync(root);
  } catch (e) {
    errors.push({
      path: root,
      reason: `scan-root unreachable: ${(e as Error).message}`,
    });
    return { items, errors, scannedFileCount, emptyInboxes, scannedAt };
  }

  for (const oracleDirName of oracleDirs) {
    const oracle = normalizeOracleName(oracleDirName);
    const inboxDir = join(root, oracleDirName, "inbox");
    let files: string[];
    try {
      files = readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // no inbox dir for this oracle — skip quietly, not an error
    }

    if (files.length === 0) {
      emptyInboxes.push(oracle);
      continue;
    }

    let oracleActiveCount = 0;

    for (const filename of files) {
      const filePath = join(inboxDir, filename);
      scannedFileCount++;

      let raw: string, fileStat: ReturnType<typeof statSync>;
      try {
        raw = readFileSync(filePath, "utf-8");
        fileStat = statSync(filePath);
      } catch (e) {
        errors.push({ path: filePath, reason: `read failed: ${(e as Error).message}` });
        continue;
      }

      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        errors.push({
          path: filePath,
          reason: "no frontmatter delimiters (---) found; skipping",
        });
        continue;
      }

      const { fm, body } = parsed;
      const { actionRequired, actionHint } = parseActionRequired(fm.action_required ?? fm.actionRequired);

      const relPath = filePath.startsWith(root + "/")
        ? filePath.slice(root.length + 1)
        : filePath;

      const id = createHash("sha256").update(filePath).digest("hex").slice(0, 12);
      const date = typeof fm.date === "string" ? fm.date : "";
      const mtime = fileStat.mtimeMs;
      const ageHours = computeAgeHours(date, mtime, scannedAt);

      const fromRaw = typeof fm.from === "string" ? fm.from : "";

      // Probe 3 (VELA 2026-04-18): directory wins EXCEPT when frontmatter
      // `to:` names a TEAM_ROSTER.cross member (currently just `leo`). Items
      // addressed to Leo are filesystem-homed in whichever oracle's inbox
      // the author chose; semantically they're Leo-pending decisions.
      const toFrontmatter = typeof fm.to === "string" ? normalizeOracleName(fm.to) : "";
      const to = TEAM_ROSTER.cross.includes(toFrontmatter as (typeof TEAM_ROSTER.cross)[number])
        ? toFrontmatter
        : oracle;

      items.push({
        id,
        path: filePath,
        relPath,
        filename,
        from: normalizeOracleName(fromRaw),
        to,
        type: typeof fm.type === "string" ? fm.type : "unknown",
        tags: asArray(fm.tags),
        confidence: normalizeConfidence(fm),
        actionRequired,
        actionHint,
        priority: normalizePriority(fm),
        date,
        ageHours,
        mtime,
        title: extractTitle(body),
        preview: extractPreview(body),
        team: teamOf(to),
        related: asArray(fm.related),
        size: fileStat.size,
      });

      if (actionRequired) oracleActiveCount++;
    }

    if (oracleActiveCount === 0 && !emptyInboxes.includes(oracle)) {
      emptyInboxes.push(oracle);
    }
  }

  return { items, errors, scannedFileCount, emptyInboxes, scannedAt };
}
