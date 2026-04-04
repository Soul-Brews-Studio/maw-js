/**
 * Loop Engine — Cron-scheduled prompt delivery to oracles.
 *
 * Loops are persistent scheduled tasks stored in maw.config.json.
 * Each loop fires a prompt to an oracle's tmux session on a cron schedule.
 * The server starts all enabled loops on boot; CLI manages them.
 */

import { loadConfig, saveConfig } from "./config";
import { logAudit } from "./audit";

export interface LoopConfig {
  id: string;
  oracle: string;
  tmux?: string;          // explicit tmux target (e.g. "01-luna-oracle:0")
  schedule: string;       // 5-field cron expression
  prompt: string;
  description?: string;
  requireIdle?: boolean;  // only fire when oracle is idle (default: true)
  enabled: boolean;
}

export interface LoopState {
  lastRun?: number;       // epoch ms
  lastOk?: boolean;
  nextRun?: number;       // epoch ms
  runCount: number;
  errors: number;
}

/** In-memory state per loop (not persisted — rebuilt on server start) */
const loopStates = new Map<string, LoopState>();
const loopTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Config helpers ────────────────────────────────────────────

export function getLoops(): LoopConfig[] {
  return (loadConfig() as any).loops || [];
}

export function getLoop(id: string): LoopConfig | undefined {
  return getLoops().find(l => l.id === id);
}

export function addLoop(loop: LoopConfig): void {
  const config = loadConfig() as any;
  const loops = [...(config.loops || [])];
  const existing = loops.findIndex((l: LoopConfig) => l.id === loop.id);
  if (existing >= 0) {
    loops[existing] = loop;
  } else {
    loops.push(loop);
  }
  saveConfig({ loops } as any);
}

export function removeLoop(id: string): boolean {
  const config = loadConfig() as any;
  const loops = (config.loops || []) as LoopConfig[];
  const filtered = loops.filter(l => l.id !== id);
  if (filtered.length === loops.length) return false;
  saveConfig({ loops: filtered } as any);
  stopLoop(id);
  return true;
}

export function enableLoop(id: string, enabled: boolean): boolean {
  const config = loadConfig() as any;
  const loops = (config.loops || []) as LoopConfig[];
  const loop = loops.find(l => l.id === id);
  if (!loop) return false;
  loop.enabled = enabled;
  saveConfig({ loops } as any);
  if (enabled) {
    scheduleNext(loop);
  } else {
    stopLoop(id);
  }
  return true;
}

// ── Cron parser (5-field: min hour dom month dow) ─────────────

function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      const start = range === "*" ? min : parseInt(range, 10);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return [...values].sort((a, b) => a - b);
}

/** Calculate the next fire time after `after` for a 5-field cron expression. */
export function nextCronTime(cron: string, after = new Date()): Date {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: expected 5 fields, got ${fields.length}`);

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const doms = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const dows = parseCronField(fields[4], 0, 6);

  // Start one minute ahead of `after`
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Scan forward up to 366 days
  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000;

  while (d.getTime() < limit) {
    if (!months.includes(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!doms.includes(d.getDate()) && !dows.includes(d.getDay())) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    // Check if EITHER dom or dow matches (standard cron behavior when both are restricted)
    const domMatch = fields[2] === "*" || doms.includes(d.getDate());
    const dowMatch = fields[4] === "*" || dows.includes(d.getDay());
    if (fields[2] !== "*" && fields[4] !== "*") {
      // Both restricted: match either (OR)
      if (!domMatch && !dowMatch) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    } else {
      if (!domMatch || !dowMatch) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    }
    if (!hours.includes(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!minutes.includes(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }

    return d;
  }

  throw new Error(`No matching cron time found within 366 days for: ${cron}`);
}

// ── Execution ─────────────────────────────────────────────────

async function fireLoop(loop: LoopConfig): Promise<void> {
  const state = loopStates.get(loop.id) || { runCount: 0, errors: 0 };

  try {
    // Use maw hey (via cmdSend) to deliver prompt to oracle
    const { cmdSend } = await import("./commands/comm");
    await cmdSend(loop.oracle, loop.prompt, true);

    state.lastRun = Date.now();
    state.lastOk = true;
    state.runCount++;
    logAudit("loop:fire", [loop.id, loop.oracle, "ok"]);
    console.log(`\x1b[32m[loop]\x1b[0m ${loop.id} → ${loop.oracle} ✓`);
  } catch (err: any) {
    state.lastRun = Date.now();
    state.lastOk = false;
    state.errors++;
    logAudit("loop:fire", [loop.id, loop.oracle, "error"], err.message?.slice(0, 200));
    console.error(`\x1b[31m[loop]\x1b[0m ${loop.id} → ${loop.oracle} ✗ ${err.message?.slice(0, 100)}`);
  }

  loopStates.set(loop.id, state);

  // Schedule next run
  scheduleNext(loop);
}

function scheduleNext(loop: LoopConfig): void {
  // Clear existing timer
  stopLoop(loop.id);

  if (!loop.enabled) return;

  try {
    const next = nextCronTime(loop.schedule);
    const delay = next.getTime() - Date.now();

    const state = loopStates.get(loop.id) || { runCount: 0, errors: 0 };
    state.nextRun = next.getTime();
    loopStates.set(loop.id, state);

    const timer = setTimeout(() => fireLoop(loop), delay);
    loopTimers.set(loop.id, timer);
  } catch (err: any) {
    console.error(`\x1b[31m[loop]\x1b[0m Failed to schedule ${loop.id}: ${err.message}`);
  }
}

function stopLoop(id: string): void {
  const timer = loopTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    loopTimers.delete(id);
  }
}

// ── Server startup ────────────────────────────────────────────

/** Start all enabled loops. Call this from server.ts on startup. */
export function startAllLoops(): void {
  const loops = getLoops();
  const enabled = loops.filter(l => l.enabled);

  if (!enabled.length) return;

  console.log(`\x1b[36m[loop]\x1b[0m Starting ${enabled.length} scheduled loop(s)`);

  for (const loop of enabled) {
    try {
      const next = nextCronTime(loop.schedule);
      const state: LoopState = { runCount: 0, errors: 0, nextRun: next.getTime() };
      loopStates.set(loop.id, state);
      scheduleNext(loop);

      const nextStr = next.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      console.log(`  \x1b[32m✓\x1b[0m ${loop.id} [${loop.oracle}] next: ${nextStr}`);
    } catch (err: any) {
      console.error(`  \x1b[31m✗\x1b[0m ${loop.id}: ${err.message}`);
    }
  }
}

/** Stop all loops (for graceful shutdown). */
export function stopAllLoops(): void {
  for (const [id] of loopTimers) {
    stopLoop(id);
  }
}

// ── State query (for CLI + API) ───────────────────────────────

export function getLoopStates(): Map<string, LoopState> {
  return loopStates;
}

/** Trigger a loop immediately (bypass schedule). */
export async function triggerLoop(id: string): Promise<boolean> {
  const loop = getLoop(id);
  if (!loop) return false;
  await fireLoop(loop);
  return true;
}
