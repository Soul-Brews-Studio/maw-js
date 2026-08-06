import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { mawDataPath } from "../../../sdk";

export type Hook =
  | { run: string }
  | { publish: string }
  | { log: string }
  | { "maw-hey": { target: string; message: string } };

export interface SchedulerJob {
  name: string;
  every: string;
  target: string;
  prompt: string;
  hooks?: {
    before?: Hook[];
    after?: Hook[];
  };
}

export interface SchedulerJobsFile {
  name?: string;
  jobs: SchedulerJob[];
}

export type SchedulerState = {
  enabled?: boolean;
  jobs?: Record<string, { lastRun?: number; startedAt?: number; status?: "running" | "done" }>;
};

export interface SchedulerPaths {
  jobsFile: string;
  stateDir: string;
  stateFile: string;
}

export function schedulerPaths(root = process.cwd(), dataPath: (...parts: string[]) => string = mawDataPath): SchedulerPaths {
  const stateDir = dataPath("scheduler");
  return {
    jobsFile: join(root, ".maw", "scheduler", "jobs.yaml"),
    stateDir,
    stateFile: join(stateDir, "state.json"),
  };
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if ((ch === "\"" || ch === "'") && line[i - 1] !== "\\") quote = quote === ch ? null : quote || ch;
    if (ch === "#" && !quote) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseHook(lines: string[], index: number, itemIndent: number, first: string): { hook: Hook; next: number } {
  const inline = first.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
  if (!inline) throw new Error(`unsupported hook near line ${index + 1}: ${first}`);
  const key = inline[1]!;
  const value = inline[2] ?? "";
  if (key === "run") return { hook: { run: unquote(value) }, next: index + 1 };
  if (key === "publish") return { hook: { publish: unquote(value) }, next: index + 1 };
  if (key === "log") return { hook: { log: unquote(value) }, next: index + 1 };
  if (key !== "maw-hey") throw new Error(`unsupported hook type '${key}' near line ${index + 1}`);
  if (value.trim()) throw new Error(`maw-hey hook must use a nested mapping near line ${index + 1}`);
  const config: Record<string, string> = {};
  index += 1;
  while (index < lines.length) {
    const line = stripComment(lines[index]!);
    if (!line.trim()) { index += 1; continue; }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= itemIndent) break;
    const field = line.trim().match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!field) throw new Error(`unsupported maw-hey field near line ${index + 1}: ${line.trim()}`);
    config[field[1]!] = unquote(field[2] ?? "");
    index += 1;
  }
  if (!config.target || !config.message) throw new Error(`maw-hey hook requires target and message near line ${index + 1}`);
  return { hook: { "maw-hey": { target: config.target, message: config.message } }, next: index };
}

export function parseJobsYaml(text: string): SchedulerJobsFile {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(stripComment);
  const out: SchedulerJobsFile = { jobs: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i += 1; continue; }
    if (/^name:\s*/.test(line)) {
      out.name = unquote(line.replace(/^name:\s*/, ""));
      i += 1;
      continue;
    }
    if (line.trim() === "jobs: []") { i += 1; continue; }
    if (line.trim() !== "jobs:") throw new Error(`unsupported top-level entry near line ${i + 1}: ${line.trim()}`);
    i += 1;
    while (i < lines.length) {
      let line = lines[i]!;
      if (!line.trim()) { i += 1; continue; }
      const item = line.match(/^ {2}-\s*(.*)$/);
      if (!item) break;
      const job: Partial<SchedulerJob> = {};
      const first = item[1] ?? "";
      if (first.trim()) {
        const field = first.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (!field) throw new Error(`unsupported job item near line ${i + 1}: ${first}`);
        (job as Record<string, unknown>)[field[1]!] = unquote(field[2] ?? "");
      }
      i += 1;
      let section: "before" | "after" | null = null;
      while (i < lines.length) {
        line = lines[i]!;
        if (!line.trim()) { i += 1; continue; }
        if (/^ {2}-\s*/.test(line) || /^\S/.test(line)) break;
        const hookItem = line.match(/^ {8}-\s*(.*)$/);
        if (hookItem && section) {
          const parsed = parseHook(lines, i, 8, hookItem[1] ?? "");
          job.hooks ??= {};
          job.hooks[section] ??= [];
          job.hooks[section]!.push(parsed.hook);
          i = parsed.next;
          continue;
        }
        const hookSection = line.match(/^ {6}(before|after):\s*$/);
        if (hookSection) {
          section = hookSection[1] as "before" | "after";
          job.hooks ??= {};
          job.hooks[section] ??= [];
          i += 1;
          continue;
        }
        const field = line.match(/^ {4}([A-Za-z][\w-]*):\s*(.*)$/);
        if (!field) throw new Error(`unsupported job field near line ${i + 1}: ${line.trim()}`);
        const key = field[1]!;
        const value = field[2] ?? "";
        if (key === "hooks") { section = null; i += 1; continue; }
        (job as Record<string, unknown>)[key] = unquote(value);
        i += 1;
      }
      for (const key of ["name", "every", "target", "prompt"] as const) {
        if (!job[key]) throw new Error(`job is missing required field '${key}'`);
      }
      out.jobs.push(job as SchedulerJob);
    }
  }
  return out;
}

export function parseEvery(value: string): number {
  const match = value.trim().match(/^(\d+)([smh])$/);
  if (!match) throw new Error(`invalid every value '${value}' (expected 10s, 2m, or 1h)`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid every value '${value}'`);
  return amount * (match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000);
}

export function loadJobs(file: string): SchedulerJobsFile {
  if (!existsSync(file)) return { jobs: [] };
  return parseJobsYaml(readFileSync(file, "utf8"));
}

export function readState(stateFile: string): SchedulerState {
  if (!existsSync(stateFile)) return { enabled: true, jobs: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as SchedulerState;
    return { enabled: parsed.enabled ?? true, jobs: parsed.jobs ?? {} };
  } catch {
    return { enabled: true, jobs: {} };
  }
}

export function writeState(stateFile: string, state: SchedulerState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ enabled: state.enabled ?? true, jobs: state.jobs ?? {} }, null, 2));
}

export function setEnabled(stateFile: string, enabled: boolean): SchedulerState {
  const state = readState(stateFile);
  state.enabled = enabled;
  writeState(stateFile, state);
  return state;
}

export function isDue(job: SchedulerJob, state: SchedulerState, now = Date.now()): boolean {
  const record = state.jobs?.[job.name];
  if (!record?.lastRun && !record?.startedAt) return true;
  const everyMs = parseEvery(job.every);
  if (record.status === "running" && record.startedAt && now - record.startedAt < everyMs) return false;
  if (!record.lastRun) return true;
  return now - record.lastRun >= everyMs;
}

export function nextDueAt(job: SchedulerJob, state: SchedulerState): number | null {
  const lastRun = state.jobs?.[job.name]?.lastRun;
  return lastRun ? lastRun + parseEvery(job.every) : null;
}

export function markStarted(stateFile: string, name: string, now = Date.now()): SchedulerState {
  const state = readState(stateFile);
  state.jobs ??= {};
  state.jobs[name] = { status: "running", startedAt: now, lastRun: state.jobs[name]?.lastRun };
  writeState(stateFile, state);
  return state;
}

export function markDone(stateFile: string, name: string, now = Date.now()): SchedulerState {
  const state = readState(stateFile);
  state.jobs ??= {};
  state.jobs[name] = { status: "done", lastRun: now };
  writeState(stateFile, state);
  return state;
}

export function validateJobPrompt(prompt: string): void {
  if (/[;&|`$<>\n\r]/.test(prompt)) {
    throw new Error(`unsafe scheduler prompt contains shell metacharacters: ${prompt}`);
  }
}
