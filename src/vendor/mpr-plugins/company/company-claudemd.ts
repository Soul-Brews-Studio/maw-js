import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { kbTagFor } from "./company-helpers";

/**
 * Managed CLAUDE.md "Department" block — the THIRD sync target alongside the
 * company registry (~/.maw/companies/<co>.json) and the per-oracle fleet config.
 *
 * Goal: a woken oracle can read its OWN CLAUDE.md and know which company /
 * department / role it belongs to — without consulting external stores.
 *
 * This module is pure string ops + a thin best-effort file-I/O wrapper. It
 * NEVER commits or pushes; the edited CLAUDE.md is left as an uncommitted
 * change for the oracle / Tony to review. Only the marked region is touched —
 * surrounding CLAUDE.md content is preserved verbatim.
 */

export const MARKER_START = "<!-- maw:company:start -->";
export const MARKER_END = "<!-- maw:company:end -->";

export interface DeptBlockData {
  company: string;
  dept: string;
  /** dept:<co>:<dept> tag; defaults to kbTagFor(company, dept) when omitted. */
  deptTag?: string;
  role?: string;
  /** Department lead oracle name; the Lead line is omitted when absent. */
  lead?: string;
}

/**
 * Build the full managed block (markers included). The Lead line is omitted
 * when the department has no lead.
 */
export function buildDeptBlock(data: DeptBlockData): string {
  const deptTag = data.deptTag ?? kbTagFor(data.company, data.dept);
  const lines = [
    MARKER_START,
    "## Department",
    `- Company: ${data.company}`,
    `- Department: ${data.dept} (${deptTag})`,
    `- Role: ${data.role ?? "—"}`,
  ];
  if (data.lead) lines.push(`- Lead: ${data.lead}`);
  lines.push(MARKER_END);
  return lines.join("\n");
}

/**
 * Insert or replace the managed block.
 * - If both markers exist, REPLACE everything between (and including) them with
 *   `block`. Idempotent — re-running with the same block yields identical output.
 * - Otherwise APPEND `block` to the end, separated from prior content by exactly
 *   one blank line.
 * Content outside the marked region is never touched.
 */
export function upsertManagedBlock(content: string, block: string): string {
  const start = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (start !== -1 && endIdx !== -1 && endIdx > start) {
    const before = content.slice(0, start);
    const after = content.slice(endIdx + MARKER_END.length);
    return before + block + after;
  }

  // Append. Trim trailing whitespace, then add exactly one blank line.
  const base = content.replace(/\s+$/, "");
  if (base === "") return block + "\n";
  return base + "\n\n" + block + "\n";
}

/**
 * Remove the managed block (markers included) if present, tidying up the
 * surrounding blank lines. No-op when absent.
 */
export function removeManagedBlock(content: string): string {
  const start = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (start === -1 || endIdx === -1 || endIdx <= start) return content;

  const before = content.slice(0, start);
  const after = content.slice(endIdx + MARKER_END.length);
  // Collapse the seam: drop trailing blank lines before the block and leading
  // blank lines after it, then rejoin with a single newline if both sides have
  // content.
  const beforeTrimmed = before.replace(/\s+$/, "");
  const afterTrimmed = after.replace(/^\s+/, "");
  if (beforeTrimmed === "") return afterTrimmed;
  if (afterTrimmed === "") return beforeTrimmed + "\n";
  return beforeTrimmed + "\n\n" + afterTrimmed;
}

/** CLAUDE.md path for a repo dir. */
function claudeMdPath(repoPath: string): string {
  return join(repoPath, "CLAUDE.md");
}

/**
 * Upsert the managed block into <repoPath>/CLAUDE.md. Best-effort:
 * - If the repo dir is missing → returns false (skip, no throw).
 * - If the repo dir exists but CLAUDE.md does not → creates a minimal CLAUDE.md
 *   containing just the block.
 * Returns true on a successful write, false (with a warn) on any failure.
 */
export function writeDeptBlock(repoPath: string, data: DeptBlockData): boolean {
  try {
    if (!existsSync(repoPath)) {
      console.warn(`[company] CLAUDE.md sync skipped — repo dir not found: ${repoPath}`);
      return false;
    }
    const file = claudeMdPath(repoPath);
    const block = buildDeptBlock(data);
    const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const next = upsertManagedBlock(existing, block);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
    return true;
  } catch (err) {
    console.warn(`[company] CLAUDE.md write failed for ${repoPath}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Remove the managed block from <repoPath>/CLAUDE.md. Best-effort:
 * - Missing repo dir or CLAUDE.md → returns false (nothing to do, no throw).
 * Returns true when a write occurred, false (or warn) otherwise.
 */
export function removeDeptBlockFromRepo(repoPath: string): boolean {
  try {
    if (!existsSync(repoPath)) return false;
    const file = claudeMdPath(repoPath);
    if (!existsSync(file)) return false;
    const existing = readFileSync(file, "utf-8");
    const next = removeManagedBlock(existing);
    if (next === existing) return false;
    writeFileSync(file, next);
    return true;
  } catch (err) {
    console.warn(`[company] CLAUDE.md block removal failed for ${repoPath}: ${(err as Error).message}`);
    return false;
  }
}
