import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolvePsi } from "./team-helpers";

export interface TeamCharterMember {
  role: string;
  target?: string;
  model?: string;
  cwd?: string;
  prompt?: string;
}

export interface TeamCharter {
  name: string;
  description?: string;
  goal?: string;
  members: TeamCharterMember[];
  lifecycle?: Record<string, unknown>;
  governance?: Record<string, unknown>;
}

export interface TeamCharterPlan {
  charter: TeamCharter;
  artifacts: string[];
  actions: string[];
  warnings: string[];
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === "\"" || ch === "'") && line[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
    }
    if (ch === "#" && !quote) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function lineIndent(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function readBlock(lines: string[], start: number, parentIndent: number): { value: string; next: number } {
  const out: string[] = [];
  let minIndent = Infinity;
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) {
      out.push("");
      continue;
    }
    const indent = lineIndent(raw);
    if (indent <= parentIndent) break;
    minIndent = Math.min(minIndent, indent);
    out.push(raw);
  }
  const trimBy = Number.isFinite(minIndent) ? minIndent : parentIndent + 2;
  return {
    value: out.map((line) => line.startsWith(" ".repeat(trimBy)) ? line.slice(trimBy) : line).join("\n").trimEnd(),
    next: i,
  };
}

function parseYamlSubset(text: string): TeamCharter {
  const lines = text.split(/\r?\n/).map(stripComment);
  const root: Record<string, unknown> = { members: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const top = line.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
    if (!top) throw new Error(`unsupported team charter YAML near line ${i + 1}: ${line.trim()}`);
    const key = top[1]!;
    const raw = top[2] ?? "";
    if (raw === "|") {
      const block = readBlock(lines, i + 1, 0);
      root[key] = block.value;
      i = block.next;
      continue;
    }
    if (key === "members" && raw === "") {
      const members: TeamCharterMember[] = [];
      i++;
      while (i < lines.length) {
        const memberLine = lines[i]!;
        if (!memberLine.trim()) {
          i++;
          continue;
        }
        if (lineIndent(memberLine) === 0) break;
        const first = memberLine.match(/^ {2}-\s+([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!first) throw new Error(`unsupported member entry near line ${i + 1}: ${memberLine.trim()}`);
        const member: Record<string, unknown> = { [first[1]!]: scalar(first[2] ?? "") };
        i++;
        while (i < lines.length) {
          const child = lines[i]!;
          if (!child.trim()) {
            i++;
            continue;
          }
          if (lineIndent(child) <= 2) break;
          const field = child.match(/^ {4}([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
          if (!field) throw new Error(`unsupported member field near line ${i + 1}: ${child.trim()}`);
          const fieldKey = field[1]!;
          const fieldRaw = field[2] ?? "";
          if (fieldRaw === "|") {
            const block = readBlock(lines, i + 1, 4);
            member[fieldKey] = block.value;
            i = block.next;
          } else {
            member[fieldKey] = scalar(fieldRaw);
            i++;
          }
        }
        members.push(member as TeamCharterMember);
      }
      root.members = members;
      continue;
    }
    if ((key === "lifecycle" || key === "governance") && raw === "") {
      const map: Record<string, unknown> = {};
      i++;
      while (i < lines.length) {
        const child = lines[i]!;
        if (!child.trim()) {
          i++;
          continue;
        }
        if (lineIndent(child) === 0) break;
        const field = child.match(/^ {2}([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!field) throw new Error(`unsupported ${key} field near line ${i + 1}: ${child.trim()}`);
        map[field[1]!] = scalar(field[2] ?? "");
        i++;
      }
      root[key] = map;
      continue;
    }
    root[key] = raw === "" ? "" : scalar(raw);
    i++;
  }
  return normalizeCharter(root);
}

function normalizeCharter(value: unknown): TeamCharter {
  if (!value || typeof value !== "object") throw new Error("team charter must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("team charter requires name");
  if (!Array.isArray(raw.members) || raw.members.length === 0) throw new Error("team charter requires at least one member");
  const members = raw.members.map((member, idx) => {
    if (!member || typeof member !== "object") throw new Error(`member ${idx + 1} must be an object`);
    const m = member as Record<string, unknown>;
    if (typeof m.role !== "string" || !m.role.trim()) throw new Error(`member ${idx + 1} requires role`);
    return {
      role: m.role.trim(),
      ...(typeof m.target === "string" && m.target.trim() ? { target: m.target.trim() } : {}),
      ...(typeof m.model === "string" && m.model.trim() ? { model: m.model.trim() } : {}),
      ...(typeof m.cwd === "string" && m.cwd.trim() ? { cwd: m.cwd.trim() } : {}),
      ...(typeof m.prompt === "string" && m.prompt.trim() ? { prompt: m.prompt.trim() } : {}),
    };
  });
  return {
    name: raw.name.trim(),
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(typeof raw.goal === "string" && raw.goal.trim() ? { goal: raw.goal.trim() } : {}),
    members,
    ...(raw.lifecycle && typeof raw.lifecycle === "object" && !Array.isArray(raw.lifecycle) ? { lifecycle: raw.lifecycle as Record<string, unknown> } : {}),
    ...(raw.governance && typeof raw.governance === "object" && !Array.isArray(raw.governance) ? { governance: raw.governance as Record<string, unknown> } : {}),
  };
}

export function parseTeamCharterText(text: string, source = "team charter"): TeamCharter {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${source} is empty`);
  if (trimmed.startsWith("{")) return normalizeCharter(JSON.parse(trimmed));
  return parseYamlSubset(text);
}

export function readTeamCharter(path: string): TeamCharter {
  return parseTeamCharterText(readFileSync(path, "utf-8"), path);
}

export function planTeamCharter(charter: TeamCharter): TeamCharterPlan {
  const teamDir = join(homedir(), ".claude", "teams", charter.name);
  const psi = resolvePsi();
  const warnings: string[] = [];
  for (const member of charter.members) {
    const target = member.target ?? "auto";
    if (target !== "auto") warnings.push(`${member.role}: target '${target}' is planned only; Phase 0 does not spawn or mutate panes`);
  }
  if (charter.governance?.requires_human_approval === true) {
    warnings.push("governance requires human approval before any future load/spawn action");
  }
  return {
    charter,
    artifacts: [
      join(teamDir, "config.json"),
      ...charter.members.map((member) => join(teamDir, "inboxes", `${member.role}.json`)),
      join(psi, "memory", "mailbox", "teams", charter.name, "manifest.json"),
    ],
    actions: [
      "read-only plan only",
      "no files written",
      "no tmux panes changed",
      "no claude processes spawned",
      "no maw bud or fleet writes",
    ],
    warnings,
  };
}

export function formatTeamCharterPlan(plan: TeamCharterPlan): string {
  const { charter } = plan;
  const lines = [
    `team charter plan: ${charter.name}`,
    charter.description ? `description: ${charter.description}` : undefined,
    charter.goal ? `goal: ${charter.goal.split(/\r?\n/)[0]}` : undefined,
    "",
    `members (${charter.members.length}):`,
    ...charter.members.map((member) => {
      const bits = [`target=${member.target ?? "auto"}`];
      if (member.model) bits.push(`model=${member.model}`);
      if (member.cwd) bits.push(`cwd=${member.cwd}`);
      return `  - ${member.role} (${bits.join(", ")})`;
    }),
    "",
    "would prepare artifacts:",
    ...plan.artifacts.map((artifact) => `  - ${artifact}`),
    "",
    "phase-0 safety:",
    ...plan.actions.map((action) => `  - ${action}`),
  ].filter((line): line is string => line !== undefined);
  if (plan.warnings.length) {
    lines.push("", "warnings:", ...plan.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}
