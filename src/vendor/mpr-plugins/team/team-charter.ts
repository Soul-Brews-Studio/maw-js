import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { assertValidOracleName } from "maw-js/core/fleet/validate";
import { resolvePsi, TEAMS_DIR, type TeamConfig, type TeamMember } from "./team-helpers";

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

export interface TeamCharterLoadResult {
  plan: TeamCharterPlan;
  writtenArtifacts: string[];
  actions: string[];
}

export type TeamCharterPreflightLevel = "ok" | "warn" | "error";

export interface TeamCharterPreflightCheck {
  level: TeamCharterPreflightLevel;
  label: string;
  detail: string;
}

export interface TeamCharterPreflightResult {
  charter: TeamCharter;
  checks: TeamCharterPreflightCheck[];
  errors: TeamCharterPreflightCheck[];
  warnings: TeamCharterPreflightCheck[];
  actions: string[];
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
  const teamDir = join(TEAMS_DIR, charter.name);
  const psi = resolvePsi();
  const warnings: string[] = [];
  for (const member of charter.members) {
    const target = member.target ?? "auto";
    if (target !== "auto") warnings.push(`${member.role}: target '${target}' is planned only; charter flow does not spawn or mutate panes yet`);
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


export function loadTeamCharter(charter: TeamCharter, opts: { noSpawn?: boolean; now?: () => number } = {}): TeamCharterLoadResult {
  if (!opts.noSpawn) throw new Error("team charter load currently requires --no-spawn");
  assertValidOracleName(charter.name);

  const plan = planTeamCharter(charter);
  const createdAt = opts.now?.() ?? Date.now();
  const teamDir = join(TEAMS_DIR, charter.name);
  const inboxDir = join(teamDir, "inboxes");
  const toolConfigPath = join(teamDir, "config.json");
  const psi = resolvePsi();
  const vaultTeamDir = join(psi, "memory", "mailbox", "teams", charter.name);
  const vaultManifestPath = join(vaultTeamDir, "manifest.json");

  const existing = [
    existsSync(toolConfigPath) ? toolConfigPath : undefined,
    existsSync(vaultManifestPath) ? vaultManifestPath : undefined,
  ].filter((value): value is string => Boolean(value));
  if (existing.length) {
    throw new Error(`team '${charter.name}' already exists; refusing to overwrite ${existing.join(", ")}`);
  }

  const members: TeamMember[] = charter.members.map((member) => ({
    name: member.role,
    ...(member.model ? { model: member.model } : {}),
    ...(member.target && member.target !== "auto" ? { backendType: member.target } : {}),
  }));
  const config: TeamConfig = {
    name: charter.name,
    ...(charter.description ? { description: charter.description } : {}),
    members,
    createdAt,
  };
  const manifest = {
    name: charter.name,
    createdAt,
    description: charter.description ?? "",
    goal: charter.goal ?? "",
    members: charter.members.map((member) => member.role),
    source: "team-charter",
    charter: {
      members: charter.members,
      ...(charter.lifecycle ? { lifecycle: charter.lifecycle } : {}),
      ...(charter.governance ? { governance: charter.governance } : {}),
    },
  };

  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(vaultTeamDir, { recursive: true });
  writeFileSync(toolConfigPath, JSON.stringify(config, null, 2));
  for (const member of charter.members) {
    writeFileSync(join(inboxDir, `${member.role}.json`), JSON.stringify([], null, 2));
  }
  writeFileSync(vaultManifestPath, JSON.stringify(manifest, null, 2));

  return {
    plan,
    writtenArtifacts: [toolConfigPath, ...charter.members.map((member) => join(inboxDir, `${member.role}.json`)), vaultManifestPath],
    actions: [
      "--no-spawn respected",
      "no tmux panes changed",
      "no claude processes spawned",
      "no maw bud or fleet writes",
    ],
  };
}

export function formatTeamCharterLoad(result: TeamCharterLoadResult): string {
  const { charter } = result.plan;
  const lines = [
    `team charter loaded: ${charter.name}`,
    "",
    "wrote artifacts:",
    ...result.writtenArtifacts.map((artifact) => `  - ${artifact}`),
    "",
    "load safety:",
    ...result.actions.map((action) => `  - ${action}`),
  ];
  if (result.plan.warnings.length) {
    lines.push("", "warnings:", ...result.plan.warnings.map((warning) => `  - ${warning}`));
  }
  lines.push("", `next: maw team list`);
  return lines.join("\n");
}


function addPreflightCheck(
  checks: TeamCharterPreflightCheck[],
  level: TeamCharterPreflightLevel,
  label: string,
  detail: string,
): void {
  checks.push({ level, label, detail });
}

export function preflightTeamCharter(charter: TeamCharter): TeamCharterPreflightResult {
  const checks: TeamCharterPreflightCheck[] = [];
  try {
    assertValidOracleName(charter.name);
    addPreflightCheck(checks, "ok", "team name", `'${charter.name}' is accepted`);
  } catch (e: any) {
    addPreflightCheck(checks, "error", "team name", e?.message || String(e));
  }

  const roles = new Set<string>();
  const duplicates = new Set<string>();
  for (const member of charter.members) {
    if (roles.has(member.role)) duplicates.add(member.role);
    roles.add(member.role);
  }
  if (duplicates.size > 0) {
    addPreflightCheck(checks, "error", "member roles", `duplicate role(s): ${[...duplicates].join(", ")}`);
  } else {
    addPreflightCheck(checks, "ok", "member roles", `${charter.members.length} unique role(s)`);
  }

  const plan = planTeamCharter(charter);
  const existing = plan.artifacts.filter((artifact) => existsSync(artifact));
  if (existing.length > 0) {
    addPreflightCheck(checks, "error", "existing artifacts", `would refuse to overwrite: ${existing.join(", ")}`);
  } else {
    addPreflightCheck(checks, "ok", "existing artifacts", "no config/inbox/manifest collisions found");
  }

  for (const member of charter.members) {
    const target = member.target ?? "auto";
    if (target === "auto") {
      addPreflightCheck(checks, "ok", `target:${member.role}`, "auto target stays local and deferred");
    } else if (/^existing:[^:]+$/.test(target)) {
      addPreflightCheck(checks, "warn", `target:${member.role}`, `${target} needs a future existing-oracle resolver and human-visible preflight`);
    } else if (/^new:[^:]+$/.test(target)) {
      addPreflightCheck(checks, "warn", `target:${member.role}`, `${target} needs a future new-oracle/bud governance gate`);
    } else {
      addPreflightCheck(checks, "error", `target:${member.role}`, `unsupported target '${target}' (expected auto, existing:<oracle>, or new:<stem>)`);
    }

    if (member.cwd) {
      if (existsSync(member.cwd)) addPreflightCheck(checks, "ok", `cwd:${member.role}`, member.cwd);
      else addPreflightCheck(checks, "warn", `cwd:${member.role}`, `${member.cwd} does not exist on this machine yet`);
    }
  }

  if (charter.governance?.requires_human_approval === true) {
    addPreflightCheck(checks, "warn", "governance", "human approval is required before future spawn/load escalation");
  } else {
    addPreflightCheck(checks, "ok", "governance", "no explicit human-approval gate requested");
  }

  return {
    charter,
    checks,
    errors: checks.filter((check) => check.level === "error"),
    warnings: checks.filter((check) => check.level === "warn"),
    actions: [
      "read-only preflight only",
      "no files written",
      "no tmux panes changed",
      "no claude processes spawned",
      "no maw bud or fleet writes",
    ],
  };
}

export function formatTeamCharterPreflight(result: TeamCharterPreflightResult): string {
  const status = result.errors.length > 0 ? "failed" : result.warnings.length > 0 ? "passed with warnings" : "passed";
  const icon = (level: TeamCharterPreflightLevel) => level === "ok" ? "✓" : level === "warn" ? "⚠" : "✗";
  return [
    `team charter preflight: ${result.charter.name}`,
    `status: ${status}`,
    "",
    "checks:",
    ...result.checks.map((check) => `  ${icon(check.level)} ${check.label}: ${check.detail}`),
    "",
    "preflight safety:",
    ...result.actions.map((action) => `  - ${action}`),
  ].join("\n");
}
