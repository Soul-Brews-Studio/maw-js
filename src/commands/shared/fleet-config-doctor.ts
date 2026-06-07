import { createHash } from "crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { getGhqRoot } from "../../config/ghq-root";
import { loadFleetEntries, type FleetEntry } from "./fleet-load";

export type ConfigFileKind = "file" | "symlink";
export type ConfigDriftStatus = "ok" | "drift" | "missing-repo" | "no-config";

export interface ConfigInventoryEntry {
  path: string;
  kind: ConfigFileKind;
  hash: string;
  size: number;
}

export interface ConfigDriftTarget {
  oracle: string;
  repo: string;
  repoPath: string;
  status: ConfigDriftStatus;
  missing: string[];
  changed: string[];
  extra: string[];
  checked: number;
}

export interface FleetConfigDoctorReport {
  baseline: {
    path: string;
    files: string[];
  };
  targets: ConfigDriftTarget[];
  summary: {
    total: number;
    ok: number;
    drift: number;
    missingRepo: number;
    noConfig: number;
  };
}

export interface FleetConfigDoctorOptions {
  baseline?: string;
  json?: boolean;
}

export interface FleetConfigDoctorDeps {
  cwd: () => string;
  ghqRoot: string;
  loadFleetEntries: () => FleetEntry[];
  existsSync: typeof existsSync;
  lstatSync: typeof lstatSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  readlinkSync: typeof readlinkSync;
  log: (...args: unknown[]) => void;
}

const CONFIG_TOP_FILES = ["CLAUDE.md", "AGENTS.md", ".mcp.json"];
const CONFIG_SUBDIRS = [
  ".claude/settings.json",
  ".claude/hooks",
  ".claude/skills",
  ".claude/commands",
  ".claude/agents",
  ".claude/prompts",
];
const IGNORED_NAMES = new Set([".DS_Store"]);

export function fleetConfigDoctorDeps(overrides: Partial<FleetConfigDoctorDeps> = {}): FleetConfigDoctorDeps {
  return {
    cwd: () => process.cwd(),
    ghqRoot: getGhqRoot(),
    loadFleetEntries,
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    log: console.log.bind(console) as (...args: unknown[]) => void,
    ...overrides,
  };
}

function configFsDeps(deps: Partial<FleetConfigDoctorDeps> = {}) {
  return {
    existsSync: deps.existsSync ?? existsSync,
    lstatSync: deps.lstatSync ?? lstatSync,
    readdirSync: deps.readdirSync ?? readdirSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    readlinkSync: deps.readlinkSync ?? readlinkSync,
  };
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function hashBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function findBaselineRoot(start: string, io: Pick<FleetConfigDoctorDeps, "existsSync">): string {
  let current = resolve(start);
  while (true) {
    if (
      io.existsSync(join(current, ".claude")) ||
      io.existsSync(join(current, "CLAUDE.md")) ||
      io.existsSync(join(current, "AGENTS.md")) ||
      io.existsSync(join(current, ".mcp.json"))
    ) return current;

    const parent = resolve(current, "..");
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function addConfigFile(
  root: string,
  absolutePath: string,
  out: Map<string, ConfigInventoryEntry>,
  io: Pick<FleetConfigDoctorDeps, "existsSync" | "lstatSync" | "readFileSync" | "readlinkSync">,
): void {
  if (!io.existsSync(absolutePath)) return;
  const stat = io.lstatSync(absolutePath);
  if (!stat.isFile() && !stat.isSymbolicLink()) return;
  const rel = toPosixPath(relative(root, absolutePath));
  if (!rel || rel.startsWith("..")) return;

  if (stat.isSymbolicLink()) {
    const target = io.readlinkSync(absolutePath);
    out.set(rel, { path: rel, kind: "symlink", hash: hashBytes(`symlink:${target}`), size: target.length });
    return;
  }

  const bytes = io.readFileSync(absolutePath);
  out.set(rel, { path: rel, kind: "file", hash: hashBytes(bytes), size: Buffer.byteLength(bytes) });
}

function walkConfigDir(
  root: string,
  dir: string,
  out: Map<string, ConfigInventoryEntry>,
  io: Pick<FleetConfigDoctorDeps, "existsSync" | "lstatSync" | "readdirSync" | "readFileSync" | "readlinkSync">,
): void {
  if (!io.existsSync(dir)) return;
  const stat = io.lstatSync(dir);
  if (stat.isFile() || stat.isSymbolicLink()) {
    addConfigFile(root, dir, out, io);
    return;
  }
  if (!stat.isDirectory()) return;

  const entries = io.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkConfigDir(root, child, out, io);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      addConfigFile(root, child, out, io);
    }
  }
}

export function buildConfigInventory(
  root: string,
  deps: Partial<FleetConfigDoctorDeps> = {},
): ConfigInventoryEntry[] {
  const io = configFsDeps(deps);
  const resolvedRoot = resolve(root);
  const out = new Map<string, ConfigInventoryEntry>();

  for (const rel of CONFIG_TOP_FILES) addConfigFile(resolvedRoot, join(resolvedRoot, rel), out, io);
  for (const rel of CONFIG_SUBDIRS) walkConfigDir(resolvedRoot, join(resolvedRoot, rel), out, io);

  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function inventoryMap(entries: ConfigInventoryEntry[]): Map<string, ConfigInventoryEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

export function compareConfigInventories(
  baseline: ConfigInventoryEntry[],
  target: ConfigInventoryEntry[],
): Pick<ConfigDriftTarget, "missing" | "changed" | "extra" | "checked"> {
  const base = inventoryMap(baseline);
  const candidate = inventoryMap(target);
  const missing: string[] = [];
  const changed: string[] = [];
  const extra: string[] = [];

  for (const [path, baseEntry] of base) {
    const targetEntry = candidate.get(path);
    if (!targetEntry) missing.push(path);
    else if (targetEntry.hash !== baseEntry.hash || targetEntry.kind !== baseEntry.kind) changed.push(path);
  }
  for (const path of candidate.keys()) {
    if (!base.has(path)) extra.push(path);
  }

  return {
    missing: missing.sort(),
    changed: changed.sort(),
    extra: extra.sort(),
    checked: baseline.length,
  };
}

function repoPathFor(repo: string, ghqRoot: string): string {
  if (isAbsolute(repo)) return repo;
  if (repo.startsWith("file://")) return repo.slice("file://".length);
  return join(ghqRoot, "github.com", repo);
}

function oracleNameFor(entry: FleetEntry, repo: string): string {
  const window = entry.session.windows.find((w) => w.repo === repo && w.name) || entry.session.windows.find((w) => w.name);
  return window?.name || entry.session.name || entry.groupName || repo.split("/").pop() || repo;
}

function fleetRepoTargets(entries: FleetEntry[], ghqRoot: string): Array<{ oracle: string; repo: string; repoPath: string }> {
  const byRepo = new Map<string, { oracle: string; repo: string; repoPath: string }>();
  for (const entry of entries) {
    for (const window of entry.session.windows || []) {
      if (!window.repo) continue;
      const repoPath = resolve(repoPathFor(window.repo, ghqRoot));
      if (byRepo.has(repoPath)) continue;
      byRepo.set(repoPath, { oracle: window.name || oracleNameFor(entry, window.repo), repo: window.repo, repoPath });
    }
  }
  return [...byRepo.values()].sort((a, b) => a.oracle.localeCompare(b.oracle) || a.repo.localeCompare(b.repo));
}

export function buildFleetConfigDoctorReport(
  opts: FleetConfigDoctorOptions = {},
  deps: Partial<FleetConfigDoctorDeps> = {},
): FleetConfigDoctorReport {
  const io = fleetConfigDoctorDeps(deps);
  const baselinePath = resolve(opts.baseline ? opts.baseline : findBaselineRoot(io.cwd(), io));
  const baseline = buildConfigInventory(baselinePath, io);
  if (baseline.length === 0) {
    throw new Error(`baseline has no supported config files: ${baselinePath}`);
  }

  const targets: ConfigDriftTarget[] = [];
  for (const target of fleetRepoTargets(io.loadFleetEntries(), io.ghqRoot)) {
    if (!io.existsSync(target.repoPath)) {
      targets.push({ ...target, status: "missing-repo", missing: [], changed: [], extra: [], checked: baseline.length });
      continue;
    }

    const inventory = buildConfigInventory(target.repoPath, io);
    if (inventory.length === 0) {
      targets.push({ ...target, status: "no-config", missing: baseline.map((entry) => entry.path), changed: [], extra: [], checked: baseline.length });
      continue;
    }

    const diff = compareConfigInventories(baseline, inventory);
    const status: ConfigDriftStatus = diff.missing.length || diff.changed.length || diff.extra.length ? "drift" : "ok";
    targets.push({ ...target, status, ...diff });
  }

  return {
    baseline: { path: baselinePath, files: baseline.map((entry) => entry.path) },
    targets,
    summary: {
      total: targets.length,
      ok: targets.filter((target) => target.status === "ok").length,
      drift: targets.filter((target) => target.status === "drift").length,
      missingRepo: targets.filter((target) => target.status === "missing-repo").length,
      noConfig: targets.filter((target) => target.status === "no-config").length,
    },
  };
}

function previewList(label: string, paths: string[], max = 6): string[] {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, max).join(", ");
  const suffix = paths.length > max ? `, +${paths.length - max} more` : "";
  return [`     ${label}: ${shown}${suffix}`];
}

export function formatFleetConfigDoctorReport(report: FleetConfigDoctorReport): string {
  const lines: string[] = [];
  const { summary } = report;
  lines.push("");
  lines.push(`  \x1b[36m\x1b[1m🧭 Fleet Config Drift Doctor\x1b[0m  \x1b[90mbaseline: ${report.baseline.path} · ${report.baseline.files.length} files\x1b[0m`);
  lines.push("");

  if (summary.total === 0) {
    lines.push("  \x1b[33m!\x1b[0m No fleet repo targets found. Run from an oracle repo or check maw fleet ls.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`  ${summary.ok} ok · ${summary.drift} drift · ${summary.noConfig} no-config · ${summary.missingRepo} missing-repo · ${summary.total} total`);
  lines.push("");

  for (const target of report.targets.filter((item) => item.status !== "ok")) {
    const icon = target.status === "missing-repo" ? "✗" : "!";
    const color = target.status === "missing-repo" ? "\x1b[31m" : "\x1b[33m";
    lines.push(`  ${color}${icon}\x1b[0m ${target.oracle}  \x1b[90m${target.repo}\x1b[0m`);
    lines.push(`     status: ${target.status} (${target.repoPath})`);
    lines.push(...previewList("missing", target.missing));
    lines.push(...previewList("changed", target.changed));
    lines.push(...previewList("extra", target.extra));
  }

  if (summary.drift === 0 && summary.noConfig === 0 && summary.missingRepo === 0) {
    lines.push("  \x1b[32m✓\x1b[0m No config drift found.");
  } else {
    lines.push("");
    lines.push("  \x1b[90mReport-only: no files changed. Review diffs before copying repo-local .claude/ config.\x1b[0m");
  }
  lines.push("");
  return lines.join("\n");
}

export async function cmdFleetConfigDoctor(
  opts: FleetConfigDoctorOptions = {},
  deps: Partial<FleetConfigDoctorDeps> = {},
): Promise<FleetConfigDoctorReport> {
  const io = fleetConfigDoctorDeps(deps);
  const report = buildFleetConfigDoctorReport(opts, io);
  io.log(opts.json ? JSON.stringify(report, null, 2) : formatFleetConfigDoctorReport(report));
  return report;
}
