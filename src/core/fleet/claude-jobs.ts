/**
 * Fleet jobs — background scripts spawned by watchers that aren't Claude
 * sessions themselves but matter operationally. Today: regression suite
 * runs (`regression-then-investigate.sh`). Easy to extend to w2-watcher,
 * cleanup loops, etc.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../transport/ssh";

export type Exec = (cmd: string) => Promise<string>;

export type JobKind = "regression" | "single-test";

export interface FleetJob {
  kind: JobKind;
  pid: number;
  startedAt: string;           // ISO
  runId?: string;              // timestamp from $RUN_DIR name
  runDir?: string;             // absolute path
  singleTest?: string;         // test filename when kind=single-test
  script: string;              // basename for display
}

export interface JobsOptions {
  exec?: Exec;
  runRoot?: string;            // override for tests
}

const DEFAULT_RUN_ROOT = join(homedir(), ".cache", "w2-watcher", "regression");
const SCRIPT_NAME = "regression-then-investigate.sh";

export async function listFleetJobs(opts: JobsOptions = {}): Promise<FleetJob[]> {
  const exec = opts.exec || hostExec;
  const runRoot = opts.runRoot || DEFAULT_RUN_ROOT;
  const pids = await findScriptPids(SCRIPT_NAME, exec);
  if (pids.length === 0) return [];

  const jobs: FleetJob[] = [];
  for (const pid of pids) {
    const startedAt = await pidStartedAt(pid, exec);
    const runDir = newestRunDir(runRoot, startedAt);
    const { kind, singleTest } = classifyJob(runDir);
    jobs.push({
      kind,
      pid,
      startedAt,
      runId: runDir ? runDir.split("/").pop() : undefined,
      runDir: runDir || undefined,
      singleTest,
      script: SCRIPT_NAME,
    });
  }
  return jobs;
}

export async function findScriptPids(basename: string, exec: Exec): Promise<number[]> {
  // pgrep matches against command + args. -f searches full command line.
  const raw = await exec(`pgrep -f '${basename.replace(/'/g, "'\\''")}' 2>/dev/null || true`).catch(() => "");
  const self = process.pid;
  return raw
    .split("\n")
    .map(l => Number(l.trim()))
    .filter(p => p > 0 && p !== self);
}

async function pidStartedAt(pid: number, exec: Exec): Promise<string> {
  const raw = (await exec(`ps -p ${pid} -o lstart= 2>/dev/null || true`).catch(() => "")).trim();
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Find the RUN_DIR a running script is writing to by taking the newest
 * timestamped dir under runRoot whose mtime is close to the script's start.
 * Avoids parsing env vars that macOS ps doesn't expose.
 */
export function newestRunDir(runRoot: string, startedAt: string): string | null {
  if (!existsSync(runRoot)) return null;
  let best: { path: string; mtime: number } | null = null;
  const startMs = new Date(startedAt).getTime();
  try {
    for (const name of readdirSync(runRoot)) {
      if (!/^\d{8}-\d{6}$/.test(name)) continue;
      const full = join(runRoot, name);
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      // Prefer dirs created within +/- 30 min of the script start time
      const dist = Math.abs(st.mtimeMs - startMs);
      if (!best || dist < Math.abs(best.mtime - startMs)) {
        best = { path: full, mtime: st.mtimeMs };
      }
    }
  } catch { /* ignore */ }
  return best?.path || null;
}

/**
 * Classify kind by scanning log files in the RUN_DIR for the script's
 * RUN_LABEL marker. "Single-test" in any log => single-test, else regression.
 */
export function classifyJob(runDir: string | null): { kind: JobKind; singleTest?: string } {
  if (!runDir) return { kind: "regression" };
  try {
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith(".log") && !name.endsWith(".txt")) continue;
      const content = readFileSync(join(runDir, name), "utf8");
      // Match "Single-test" or SINGLE_TEST=<file>
      if (/Single-test\b/i.test(content)) {
        const m = content.match(/SINGLE_TEST=(\S+)/) || content.match(/single test[^:]*:\s*(\S+)/i);
        return { kind: "single-test", singleTest: m?.[1] };
      }
      if (/\bRegression\b/.test(content)) return { kind: "regression" };
    }
  } catch { /* ignore */ }
  return { kind: "regression" };
}
