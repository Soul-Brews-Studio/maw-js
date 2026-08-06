import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { assertValidOracleName } from "maw-js/core/fleet/validate";
import { resolvePsi, TEAMS_DIR, type TeamConfig, type TeamMember } from "./team-helpers";
import { cmdTeamCreate, cmdTeamSpawn } from "./team-lifecycle";

export interface TeamCharterMember {
  role: string;
  name?: string;
  target?: string;
  model?: string;
  cwd?: string;
  prompt?: string;
  engine?: string;
  worktree?: boolean | string;
  branch?: string;
  queue?: string[];
  node?: string;
  channels?: boolean;
  /** New-style per-member channel override (`false` disables top-level `discord`). */
  discord?: false;
}

export type TeamCharterFlags = Record<string, unknown[]>;
export type TeamCharterEngines = Record<string, unknown>;

export interface TeamCharter {
  name: string;
  description?: string;
  goal?: string;
  session?: string;
  /** Optional top-level project slug for generated wake targets (`owner/repo`). */
  project?: string;
  /** Optional top-level discord bridge toggle. `false` disables, string enables. */
  discord?: string | false;
  defaults?: Partial<TeamCharterMember>;
  members: TeamCharterMember[];
  /** Reusable argv fragments, including YAML-anchor-expanded arrays. */
  flags?: TeamCharterFlags;
  /** Charter-local engine command map; arrays are flattened at launch resolution. */
  engines?: TeamCharterEngines;
  /** New-style agent map (`agents: { codex: { engine: omx, ... } }`). */
  agents?: Record<string, Record<string, unknown>>;
  lifecycle?: Record<string, unknown>;
  governance?: Record<string, unknown>;
  warnings?: string[];
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

export interface TeamCharterSpawnResult {
  charter: TeamCharter;
  spawnedRoles: string[];
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


function cloneYamlValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneYamlValue(item)) as T;
  if (value && typeof value === "object") return { ...(value as Record<string, unknown>) } as T;
  return value;
}

function splitInlineArray(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  const out: string[] = [];
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if ((ch === '"' || ch === "'") && inner[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
      current += ch;
      continue;
    }
    if (ch === "," && !quote) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseYamlValue(raw: string, anchors: Map<string, unknown>): unknown {
  const trimmed = raw.trim();
  const alias = trimmed.match(/^\*([A-Za-z_][\w-]*)$/);
  if (alias) {
    if (!anchors.has(alias[1]!)) throw new Error(`unknown YAML anchor reference: *${alias[1]}`);
    return cloneYamlValue(anchors.get(alias[1]));
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitInlineArray(trimmed).map((item) => parseYamlValue(item, anchors));
  }
  return scalar(trimmed);
}

function parseListBlock(lines: string[], start: number, parentIndent: number, anchors: Map<string, unknown>): { value: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const itemLine = lines[i]!;
    if (!itemLine.trim()) continue;
    if (lineIndent(itemLine) <= parentIndent) break;
    const item = itemLine.match(new RegExp(`^ {${parentIndent + 2}}-\\s*(.*)$`));
    if (!item) throw new Error(`unsupported list item near line ${i + 1}: ${itemLine.trim()}`);
    items.push(parseYamlValue(item[1] ?? "", anchors));
  }
  return { value: items, next: i };
}

function parseAnchorPrefix(raw: string): { anchor?: string; rest: string } {
  const match = raw.trim().match(/^&([A-Za-z_][\w-]*)(?:\s+(.*))?$/);
  return match ? { anchor: match[1], rest: match[2] ?? "" } : { rest: raw };
}

function parseYamlValueMapBlock(lines: string[], start: number, parentIndent: number, anchors: Map<string, unknown>): { value: Record<string, unknown>; next: number } {
  const out: Record<string, unknown> = {};
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const indent = lineIndent(raw);
    if (indent <= parentIndent) break;

    const header = raw.match(new RegExp(`^ {${parentIndent + 2}}([A-Za-z_][\\w.-]*):(?:\\s*(.*))?$`));
    if (!header) throw new Error(`unsupported value map entry near line ${i + 1}: ${raw.trim()}`);
    const key = header[1]!;
    const keyValue = header[2] ?? "";
    const { anchor, rest } = parseAnchorPrefix(keyValue);
    let value: unknown;
    if (rest.trim()) {
      value = parseYamlValue(rest, anchors);
      i++;
    } else if (keyValue.trim() && !anchor) {
      value = parseYamlValue(keyValue, anchors);
      i++;
    } else {
      const list = parseListBlock(lines, i + 1, parentIndent + 2, anchors);
      value = list.value;
      i = list.next;
    }
    if (anchor) anchors.set(anchor, cloneYamlValue(value));
    out[key] = value;
    i--;
  }
  return { value: out, next: i };
}

function parseYamlMapBlock(lines: string[], start: number, parentIndent: number, anchors: Map<string, unknown>): { value: Record<string, Record<string, unknown>>; next: number } {
  const out: Record<string, Record<string, unknown>> = {};
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const indent = lineIndent(raw);
    if (indent <= parentIndent) break;

    const header = raw.match(/^ {2}([A-Za-z_][\w.-]*):(?:\s*(.*))?$/);
    if (!header) throw new Error(`unsupported map entry near line ${i + 1}: ${raw.trim()}`);
    const key = header[1]!;
    const keyValue = header[2] ?? "";
    if (keyValue.trim()) throw new Error(`unsupported map value near line ${i + 1}: ${raw.trim()}`);

    const record: Record<string, unknown> = {};
    i++;
    while (i < lines.length) {
      const child = lines[i]!;
      if (!child.trim()) {
        i++;
        continue;
      }
      if (lineIndent(child) <= 2) break;
      const field = child.match(/^ {4}([A-Za-z_][\w.-]*):(?:\s*(.*))?$/);
      if (!field) throw new Error(`unsupported map field near line ${i + 1}: ${child.trim()}`);
      const fieldKey = field[1]!;
      const fieldRaw = field[2] ?? "";
      if (fieldRaw === "|") {
        const block = readBlock(lines, i + 1, 4);
        record[fieldKey] = block.value;
        i = block.next;
      } else if (fieldRaw === "") {
        const items: unknown[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const itemLine = lines[j]!;
          if (!itemLine.trim()) {
            j++;
            continue;
          }
          if (lineIndent(itemLine) <= 4) break;
          const item = itemLine.match(/^ {6}-\s*(.*)$/);
          if (!item) throw new Error(`unsupported map field near line ${j + 1}: ${itemLine.trim()}`);
          items.push(parseYamlValue(item[1] ?? "", anchors));
          j++;
        }
        record[fieldKey] = items;
        i = j;
      } else {
        record[fieldKey] = parseYamlValue(fieldRaw, anchors);
        i++;
      }
    }
    out[key] = record;
    if (i < lines.length && lines[i]?.trim() && lineIndent(lines[i]!) > parentIndent) i--;
  }
  return { value: out, next: i };
}

function parseFlatScalarMapBlock(lines: string[], start: number, parentIndent: number, label: string, anchors: Map<string, unknown>): { value: Record<string, unknown>; next: number } {
  const map: Record<string, unknown> = {};
  let i = start;
  for (; i < lines.length; i++) {
    const child = lines[i]!;
    if (!child.trim()) continue;
    if (lineIndent(child) <= parentIndent) break;
    const field = child.match(/^ {2}([A-Za-z_][\w.-]*):\s*(.*)$/);
    if (!field) throw new Error(`unsupported ${label} field near line ${i + 1}: ${child.trim()}`);
    map[field[1]!] = parseYamlValue(field[2] ?? "", anchors);
  }
  return { value: map, next: i };
}

function parseYamlSubset(text: string): TeamCharter {
  const lines = text.split(/\r?\n/).map(stripComment);
  const anchors = new Map<string, unknown>();
  const root: Record<string, unknown> = { members: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const top = line.match(/^([A-Za-z_][\w.-]*):(?:\s*(.*))?$/);
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
        const member: Record<string, unknown> = { [first[1]!]: parseYamlValue(first[2] ?? "", anchors) };
        i++;
        while (i < lines.length) {
          const child = lines[i]!;
          if (!child.trim()) {
            i++;
            continue;
          }
          if (lineIndent(child) <= 2) break;
          const field = child.match(/^ {4}([A-Za-z_][\w.-]*):(?:\s*(.*))?$/);
          if (!field) throw new Error(`unsupported member field near line ${i + 1}: ${child.trim()}`);
          const fieldKey = field[1]!;
          const fieldRaw = field[2] ?? "";
          if (fieldRaw === "|") {
            const block = readBlock(lines, i + 1, 4);
            member[fieldKey] = block.value;
            i = block.next;
          } else if (fieldRaw === "") {
            const items: unknown[] = [];
            let j = i + 1;
            while (j < lines.length) {
              const itemLine = lines[j]!;
              if (!itemLine.trim()) {
                j++;
                continue;
              }
              if (lineIndent(itemLine) <= 4) break;
              const item = itemLine.match(/^ {6}-\s*(.*)$/);
              if (!item) throw new Error(`unsupported member field near line ${j + 1}: ${itemLine.trim()}`);
              items.push(parseYamlValue(item[1] ?? "", anchors));
              j++;
            }
            member[fieldKey] = items;
            i = j;
          } else {
            member[fieldKey] = parseYamlValue(fieldRaw, anchors);
            i++;
          }
        }
        members.push(member as TeamCharterMember);
      }
      root.members = members;
      continue;
    }
    if ((key === "flags" || key === "engines") && raw === "") {
      const block = parseYamlValueMapBlock(lines, i + 1, 0, anchors);
      i = block.next;
      root[key] = block.value;
      continue;
    }
    if (key === "agents" && raw === "") {
      const block = parseYamlMapBlock(lines, i + 1, 0, anchors);
      i = block.next;
      root.agents = block.value;
      continue;
    }
    if ((key === "defaults" || key === "lifecycle" || key === "governance") && raw === "") {
      const block = parseFlatScalarMapBlock(lines, i + 1, 0, key, anchors);
      root[key] = block.value;
      i = block.next;
      continue;
    }
    root[key] = raw === "" ? "" : parseYamlValue(raw, anchors);
    i++;
  }
  return normalizeCharter(root);
}

const KNOWN_TOP_LEVEL_KEYS = new Set(["name", "description", "goal", "session", "project", "discord", "defaults", "flags", "engines", "members", "agents", "lifecycle", "governance"]);
const KNOWN_MEMBER_KEYS = new Set(["role", "name", "target", "model", "cwd", "prompt", "engine", "worktree", "branch", "queue", "node", "channels", "discord"]);

function normalizeTeamMember(roleRaw: string, m: Record<string, unknown>): TeamCharterMember {
  const role = roleRaw.trim();
  if (!role) throw new Error("agent key must be non-empty");
  return {
    role,
    ...(typeof m.name === "string" && m.name.trim() ? { name: m.name.trim() } : {}),
    ...(typeof m.target === "string" && m.target.trim() ? { target: m.target.trim() } : {}),
    ...(typeof m.model === "string" && m.model.trim() ? { model: m.model.trim() } : {}),
    ...(typeof m.cwd === "string" && m.cwd.trim() ? { cwd: m.cwd.trim() } : {}),
    ...(typeof m.prompt === "string" && m.prompt.trim() ? { prompt: m.prompt.trim() } : {}),
    ...(typeof m.engine === "string" && m.engine.trim() ? { engine: m.engine.trim() } : {}),
    ...(typeof m.worktree === "boolean" ? { worktree: m.worktree } : {}),
    ...(typeof m.worktree === "string" && m.worktree.trim() ? { worktree: m.worktree.trim() } : {}),
    ...(typeof m.branch === "string" && m.branch.trim() ? { branch: m.branch.trim() } : {}),
    ...(Array.isArray(m.queue) ? { queue: m.queue.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim()) } : {}),
    ...(typeof m.queue === "string" && m.queue.trim() ? { queue: [m.queue.trim()] } : {}),
    ...(typeof m.node === "string" && m.node.trim() ? { node: m.node.trim() } : {}),
    ...(typeof m.channels === "boolean" ? { channels: m.channels } : {}),
    ...(typeof m.discord === "boolean" && m.discord === false ? { discord: false } : {}),
  };
}

function normalizeTeamMemberDefaults(defaults: Record<string, unknown>): Partial<TeamCharterMember> {
  const memberDefaults: Partial<TeamCharterMember> = { ...normalizeTeamMember("defaults", defaults) };
  delete memberDefaults.role;
  return memberDefaults;
}

function normalizeCharter(value: unknown): TeamCharter {
  if (!value || typeof value !== "object") throw new Error("team charter must be an object");
  const raw = value as Record<string, unknown>;
  const warnings: string[] = [];

  for (const [key] of Object.entries(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`team charter has unsupported top-level key: ${key}`);
    }
  }

  const defaults = (raw.defaults && typeof raw.defaults === "object" && !Array.isArray(raw.defaults))
    ? raw.defaults as Record<string, unknown>
    : {};
  for (const [key] of Object.entries(defaults)) {
    if (!KNOWN_MEMBER_KEYS.has(key)) warnings.push(`defaults has unsupported key: ${key}`);
  }

  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("team charter requires name");
  const membersFromList = Array.isArray(raw.members) ? raw.members.map((member, idx) => {
    if (!member || typeof member !== "object") throw new Error(`member ${idx + 1} must be an object`);
    const m = member as Record<string, unknown>;
    for (const [key] of Object.entries(m)) {
      if (!KNOWN_MEMBER_KEYS.has(key)) {
        const memberRole = typeof m.role === "string" && m.role.trim() ? m.role.trim() : `#${idx + 1}`;
        warnings.push(`member '${memberRole}' has unsupported key: ${key}`);
      }
    }
    if (typeof m.role !== "string" || !m.role.trim()) throw new Error(`member ${idx + 1} requires role`);

    return normalizeTeamMember(m.role.trim(), { ...defaults, ...m });
  }) : [];
  const membersFromAgents = (raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents))
    ? Object.entries(raw.agents).map(([agentKey, agentValue], idx) => {
      if (!agentValue || typeof agentValue !== "object" || Array.isArray(agentValue)) {
        throw new Error(`agent ${idx + 1} ('${agentKey}') must be a map`);
      }
      const m = agentValue as Record<string, unknown>;
      for (const [key] of Object.entries(m)) {
        if (!KNOWN_MEMBER_KEYS.has(key)) warnings.push(`member '${agentKey}' has unsupported key: ${key}`);
      }
      return normalizeTeamMember(agentKey, { ...defaults, ...m });
    })
    : [];
  const members = [...membersFromList, ...membersFromAgents];
  if (members.length === 0) throw new Error("team charter requires at least one member");
  return {
    name: raw.name.trim(),
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(typeof raw.goal === "string" && raw.goal.trim() ? { goal: raw.goal.trim() } : {}),
    ...(typeof raw.project === "string" && raw.project.trim() ? { project: raw.project.trim() } : {}),
    ...(raw.discord === false ? { discord: false } : typeof raw.discord === "string" ? { discord: raw.discord.trim() } : {}),
    ...(typeof raw.session === "string" && raw.session.trim() ? { session: raw.session.trim() } : {}),
    ...(Object.keys(defaults).length ? { defaults: normalizeTeamMemberDefaults(defaults) } : {}),
    members,
    ...(raw.flags && typeof raw.flags === "object" && !Array.isArray(raw.flags) ? { flags: raw.flags as TeamCharterFlags } : {}),
    ...(raw.engines && typeof raw.engines === "object" && !Array.isArray(raw.engines) ? { engines: raw.engines as TeamCharterEngines } : {}),
    ...(raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents) ? { agents: raw.agents as Record<string, Record<string, unknown>> } : {}),
    ...(warnings.length ? { warnings } : {}),
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
      if (member.name) bits.push(`name=${member.name}`);
      if (member.model) bits.push(`model=${member.model}`);
      if (member.cwd) bits.push(`cwd=${member.cwd}`);
      if (member.engine) bits.push(`engine=${member.engine}`);
      if (member.worktree) bits.push(`worktree=${member.worktree}`);
      if (member.branch) bits.push(`branch=${member.branch}`);
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
  if (charter.warnings?.length) {
    lines.push("", "parser warnings:", ...charter.warnings.map((warning) => `  - ${warning}`));
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
      ...(charter.defaults ? { defaults: charter.defaults } : {}),
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

  for (const warning of charter.warnings ?? []) {
    addPreflightCheck(checks, "warn", "parser", warning);
  }

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


export function composeTeamCharterMemberPrompt(charter: TeamCharter, member: TeamCharterMember): string {
  return [
    charter.goal ? `## Team goal\n${charter.goal}` : undefined,
    member.prompt ? `## Role prompt\n${member.prompt}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

export async function spawnFromTeamCharter(
  charter: TeamCharter,
  opts: { approve?: boolean; exec?: boolean } = {},
): Promise<TeamCharterSpawnResult> {
  const preflight = preflightTeamCharter(charter);
  if (preflight.errors.length > 0) {
    throw new Error(`preflight failed: ${preflight.errors.map((check) => `${check.label}: ${check.detail}`).join("; ")}`);
  }
  if (charter.governance?.requires_human_approval === true && !opts.approve) {
    throw new Error("governance requires human approval; re-run with --approve to spawn local target:auto members");
  }
  const unsupportedTargets = charter.members
    .filter((member) => (member.target ?? "auto") !== "auto")
    .map((member) => `${member.role}=${member.target}`);
  if (unsupportedTargets.length > 0) {
    throw new Error(`charter spawn currently supports only target:auto; blocked ${unsupportedTargets.join(", ")}`);
  }

  cmdTeamCreate(charter.name, { description: charter.description });
  const spawnedRoles: string[] = [];
  for (const member of charter.members) {
    await cmdTeamSpawn(charter.name, member.role, {
      model: member.model,
      cwd: member.cwd,
      prompt: composeTeamCharterMemberPrompt(charter, member),
      exec: opts.exec,
    });
    spawnedRoles.push(member.role);
  }
  return {
    charter,
    spawnedRoles,
    actions: [
      "preflight passed",
      opts.approve ? "governance approval flag present" : "no governance approval required",
      opts.exec ? "--exec passed through to local cmdTeamSpawn" : "spawn prompts written; no tmux panes spawned without --exec",
      "existing:* and new:* targets blocked in this implementation",
    ],
  };
}

export function formatTeamCharterSpawn(result: TeamCharterSpawnResult): string {
  return [
    `team charter spawn complete: ${result.charter.name}`,
    "",
    `roles (${result.spawnedRoles.length}):`,
    ...result.spawnedRoles.map((role) => `  - ${role}`),
    "",
    "spawn safety:",
    ...result.actions.map((action) => `  - ${action}`),
  ].join("\n");
}
