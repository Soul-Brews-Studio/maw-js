import { Elysia} from "elysia";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// A session transcript is streamed line-by-line rather than read whole: some
// real transcripts are 500MB+, so readFile + split("\n") would allocate ~1GB
// and block the event loop in one shot. Streaming keeps memory bounded (to the
// longest single line) and lets the scan yield between chunks.
type ReadLinesAsync = (path: string) => AsyncIterable<string>;
type ReaddirAsync = (path: string) => Promise<string[]>;
type StatAsync = (path: string) => Promise<{ isDirectory: () => boolean; mtimeMs?: number; size?: number }>;

/** Default line reader: stream a file and split into lines without buffering it whole. */
async function* streamLines(path: string): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = "";
  // @ts-ignore Bun global
  for await (const chunk of Bun.file(path).stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    // Split off complete lines in one pass (O(n)); keep the trailing partial.
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) yield line;
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

// Tiny concurrency pool (no new dependency): reads/parses session files
// concurrently but bounded, so a costs scan never monopolizes the event loop.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// Cost per million tokens (USD)
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.25, output: 1.25 },
};

function modelTier(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "sonnet"; // default
}

function agentNameFromDir(dir: string): string {
  // Dir like "-home-nat-Code-github-com-laris-co-neo-oracle"
  // Extract the last meaningful segment(s)
  const parts = dir.replace(/^-/, "").split("-");
  // Find github-com pattern and take org/repo after it
  const ghIdx = parts.indexOf("github");
  if (ghIdx >= 0 && parts[ghIdx + 1] === "com" && parts.length > ghIdx + 3) {
    return parts.slice(ghIdx + 2).join("-");
  }
  // Fallback: last 2 segments
  return parts.slice(-2).join("-");
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  turns: number;
  model: string;
  lastTimestamp: string;
}

function estimateCost(usage: SessionUsage): number {
  const tier = modelTier(usage.model);
  const rates = COST_PER_MTOK[tier] || COST_PER_MTOK.sonnet;
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
  return (totalInput / 1_000_000) * rates.input + (usage.outputTokens / 1_000_000) * rates.output;
}

// ---------------------------------------------------------------------------
// Helpers for /costs/daily
// ---------------------------------------------------------------------------

/** Convert an ISO timestamp string to a local-TZ "YYYY-MM-DD" string. */
function localDateStr(isoTs: string): string {
  const d = new Date(isoTs);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Generate N date strings (local TZ) ending today (inclusive), oldest first.
 * Uses UTC arithmetic then converts to local date — DST-safe for display.
 */
function makeBuckets(n: number): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getTime() - (n - 1 - i) * 86_400_000);
    return localDateStr(d.toISOString());
  });
}

export interface CostsApiDeps {
  projectsDir: string;
  readdir: ReaddirAsync;
  readLines: ReadLinesAsync;
  stat: StatAsync;
  join: typeof join;
}

interface ScannedFile { agentName: string; usage: SessionUsage }

const SCAN_TTL_MS = 30_000;

export function createCostsApi(deps: CostsApiDeps = {
  projectsDir: join(homedir(), ".claude", "projects"),
  readdir: (path) => readdir(path),
  readLines: streamLines,
  stat: (path) => stat(path),
  join,
}) {
  // Per-instance cache so /costs and /costs/daily share a single async scan and
  // frequent dashboard polls don't re-read every ~/.claude/projects/*.jsonl.
  // Scoped to the factory (not module) so injected test apps never cross-talk.
  let scanCache: { data: ScannedFile[]; ts: number } | null = null;

  // Per-file usage cache keyed by (mtimeMs, size). jsonl transcripts are
  // append-only and some are 500MB+; without this a cold scan would re-read
  // gigabytes every time. A file is read once, then skipped until it changes.
  // (When stat lacks mtime/size — e.g. injected test stubs — caching is off.)
  const fileCache = new Map<string, { mtimeMs: number; size: number; usage: SessionUsage | null }>();

  async function scanSessionWithDeps(filePath: string): Promise<SessionUsage | null> {
    try {
      return await scanSessionContent(deps.readLines(filePath));
    } catch {
      return null;
    }
  }

  async function projectDirs(set: { status?: number }): Promise<string[] | null> {
    try {
      const all = await deps.readdir(deps.projectsDir);
      const flags = await Promise.all(all.map(async (d) => {
        try { return (await deps.stat(deps.join(deps.projectsDir, d))).isDirectory(); }
        catch { return false; }
      }));
      return all.filter((_, i) => flags[i]);
    } catch {
      set.status = 500;
      return null;
    }
  }

  // Scan every session file once (concurrently, cached). Returns per-file usage
  // tagged with agent name; both endpoints aggregate from this.
  async function collectUsages(set: { status?: number }): Promise<ScannedFile[] | null> {
    const now = Date.now();
    if (scanCache && now - scanCache.ts < SCAN_TTL_MS) return scanCache.data;

    const dirs = await projectDirs(set);
    if (!dirs) return null;

    const targets: { filePath: string; agentName: string }[] = [];
    for (const dir of dirs) {
      const dirPath = deps.join(deps.projectsDir, dir);
      let files: string[];
      try { files = (await deps.readdir(dirPath)).filter((f) => f.endsWith(".jsonl")); }
      catch { continue; }
      const agentName = agentNameFromDir(dir);
      for (const file of files) targets.push({ filePath: deps.join(dirPath, file), agentName });
    }

    const scanned = await mapPool(targets, 8, async ({ filePath, agentName }) => {
      let st: { mtimeMs?: number; size?: number } | null = null;
      try { st = await deps.stat(filePath); } catch { /* file vanished mid-scan */ }
      const mtimeMs = st?.mtimeMs;
      const size = st?.size;

      let usage: SessionUsage | null;
      const cached = (mtimeMs !== undefined && size !== undefined) ? fileCache.get(filePath) : undefined;
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        usage = cached.usage; // unchanged since last scan — skip the (re)read
      } else {
        usage = await scanSessionWithDeps(filePath);
        if (mtimeMs !== undefined && size !== undefined) fileCache.set(filePath, { mtimeMs, size, usage });
      }
      return usage ? { agentName, usage } : null;
    });
    const data = scanned.filter((x): x is ScannedFile => x !== null);
    scanCache = { data, ts: now };
    return data;
  }

  const api = new Elysia();

  api.get("/costs/daily", async ({ query, set }) => {
    const days = Number(query.days ?? 7);
    if (isNaN(days) || days < 1 || days > 365) {
      set.status = 400;
      return { error: "days must be 1–365" };
    }

    const buckets = makeBuckets(days);
    const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

    const scanned = await collectUsages(set);
    if (!scanned) return { error: "Cannot read ~/.claude/projects/" };

    // agentName → { costs: number[], hadActivity: boolean[] }
    const agentDailyMap = new Map<string, { costs: number[]; hadActivity: boolean[] }>();

    for (const { agentName, usage } of scanned) {
      if (!agentDailyMap.has(agentName)) {
        agentDailyMap.set(agentName, {
          costs: Array(days).fill(0),
          hadActivity: Array(days).fill(false),
        });
      }

      const entry = agentDailyMap.get(agentName)!;

      if (!usage.lastTimestamp) continue;
      const dateStr = localDateStr(usage.lastTimestamp);
      const idx = bucketIndex.get(dateStr);
      if (idx === undefined) continue; // outside the window

      entry.costs[idx] += estimateCost(usage);
      entry.hadActivity[idx] = true;
    }

    const agents = [...agentDailyMap.entries()]
      .filter(([, d]) => d.costs.reduce((s, v) => s + v, 0) > 0)
      .map(([name, d]) => ({
        name,
        dailyCosts: d.costs,
        totalCost: d.costs.reduce((s, v) => s + v, 0),
        hadActivity: d.hadActivity,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);

    const totalCost = agents.reduce((s, a) => s + a.totalCost, 0);
    return { window: days, buckets, agents, total: { cost: totalCost, agents: agents.length } };
  });

  api.get("/costs", async ({ set }) => {
    const scanned = await collectUsages(set);
    if (!scanned) return { error: "Cannot read ~/.claude/projects/" };

    const agents: Record<string, {
      name: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreateTokens: number;
      totalTokens: number;
      estimatedCost: number;
      sessions: number;
      turns: number;
      models: Record<string, number>;
      lastActive: string;
    }> = {};

    for (const { agentName, usage } of scanned) {
      if (!agents[agentName]) {
        agents[agentName] = {
          name: agentName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          sessions: 0,
          turns: 0,
          models: {},
          lastActive: "",
        };
      }

      const a = agents[agentName];
      a.inputTokens += usage.inputTokens;
      a.outputTokens += usage.outputTokens;
      a.cacheReadTokens += usage.cacheReadTokens;
      a.cacheCreateTokens += usage.cacheCreateTokens;
      a.totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
      a.estimatedCost += estimateCost(usage);
      a.sessions++;
      a.turns += usage.turns;

      const tier = modelTier(usage.model);
      a.models[tier] = (a.models[tier] || 0) + usage.turns;

      if (usage.lastTimestamp > a.lastActive) a.lastActive = usage.lastTimestamp;
    }

    const agentList = Object.values(agents)
      .filter((a) => a.sessions > 0)
      .sort((a, b) => b.estimatedCost - a.estimatedCost);

    const total = {
      tokens: agentList.reduce((s, a) => s + a.totalTokens, 0),
      cost: agentList.reduce((s, a) => s + a.estimatedCost, 0),
      sessions: agentList.reduce((s, a) => s + a.sessions, 0),
      agents: agentList.length,
    };

    return { agents: agentList, total };
  });

  return api;
}

/** Yield control back to the event loop so a large parse never freezes serve. */
const yieldToLoop = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

async function scanSessionContent(lines: AsyncIterable<string>): Promise<SessionUsage | null> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let turns = 0;
  let model = "";
  let lastTimestamp = "";

  let seen = 0;
  for await (const line of lines) {
    // Periodically hand the event loop back so websockets/keystrokes stay
    // responsive while a big transcript is being scanned.
    if ((++seen & 2047) === 0) await yieldToLoop();

    // Cheap pre-filter: only usage-bearing assistant lines matter, so skip the
    // JSON.parse for the (vast majority of) lines that can't contribute.
    if (!line || line.indexOf('"usage"') === -1) continue;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;

    const u = obj.message.usage;
    inputTokens += u.input_tokens || 0;
    outputTokens += u.output_tokens || 0;
    cacheReadTokens += u.cache_read_input_tokens || 0;
    cacheCreateTokens += u.cache_creation_input_tokens || 0;
    turns++;

    if (obj.message.model && !model) model = obj.message.model;
    if (obj.timestamp) lastTimestamp = obj.timestamp;
  }

  if (turns === 0) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, turns, model, lastTimestamp };
}

export const costsApi = createCostsApi();
