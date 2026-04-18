import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InboxItem, ParseError } from "./types";

type Frontmatter = Record<string, string | string[] | number>;

interface ParsedDoc {
  frontmatter: Frontmatter;
  body: string;
}

function parseScalar(raw: string): string | number {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => {
    const t = s.trim();
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    return t;
  });
}

export function parseFrontmatter(content: string): ParsedDoc {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content };
  }
  const afterOpen = content.indexOf("\n") + 1;
  const closeIdx = content.indexOf("\n---", afterOpen);
  if (closeIdx === -1) {
    throw new Error("unclosed frontmatter fence");
  }
  const block = content.slice(afterOpen, closeIdx);
  const rest = content.slice(closeIdx + 4).replace(/^\r?\n/, "");

  const fm: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (!key) throw new Error(`empty key in frontmatter`);
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      fm[key] = parseList(rawVal);
    } else if (rawVal === "") {
      fm[key] = "";
    } else {
      fm[key] = parseScalar(rawVal);
    }
  }
  return { frontmatter: fm, body: rest };
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t.replace(/^#+\s*/, "");
  }
  return "";
}

function listMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function listOracleDirs(vaultRoot: string): string[] {
  try {
    return readdirSync(vaultRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(vaultRoot, e.name));
  } catch {
    return [];
  }
}

export async function scanInboxes(
  vaultRoot: string,
  opts?: { maxFiles?: number },
): Promise<{ items: InboxItem[]; errors: ParseError[] }> {
  const items: InboxItem[] = [];
  const errors: ParseError[] = [];
  const max = opts?.maxFiles ?? Infinity;
  const now = Date.now();

  for (const oracleDir of listOracleDirs(vaultRoot)) {
    for (const filePath of listMdFiles(join(oracleDir, "inbox"))) {
      if (items.length + errors.length >= max) return { items, errors };
      let raw: string;
      let mtime: number;
      try {
        raw = readFileSync(filePath, "utf8");
        mtime = statSync(filePath).mtimeMs;
      } catch (e) {
        errors.push({ path: filePath, reason: `read failed: ${(e as Error).message}` });
        continue;
      }

      let parsed: ParsedDoc;
      try {
        parsed = parseFrontmatter(raw);
      } catch (e) {
        errors.push({ path: filePath, reason: (e as Error).message });
        continue;
      }

      const fm = parsed.frontmatter;
      const missing = ["recipient", "sender", "type"].filter(
        (k) => typeof fm[k] !== "string" || !(fm[k] as string),
      );
      if (missing.length) {
        errors.push({ path: filePath, reason: `missing required: ${missing.join(", ")}` });
        continue;
      }

      const subject =
        (typeof fm.subject === "string" && fm.subject) || firstNonEmptyLine(parsed.body) || "";
      const team = typeof fm.team === "string" ? fm.team : undefined;

      items.push({
        recipient: fm.recipient as string,
        sender: fm.sender as string,
        team,
        type: fm.type as string,
        subject,
        body: parsed.body,
        path: filePath,
        mtime,
        ageHours: Math.max(0, (now - mtime) / 3600000),
        schemaVersion: 1,
      });
    }
  }

  return { items, errors };
}
