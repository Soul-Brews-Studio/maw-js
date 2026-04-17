import { Elysia} from "elysia";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

export const costsApi = new Elysia();

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

function scanSession(filePath: string): SessionUsage | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    let turns = 0;
    let model = "";
    let lastTimestamp = "";

    for (const line of lines) {
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
  } catch {
    return null;
  }
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

costsApi.get("/costs/daily", ({ query, set }) => {
  const days = Number(query.days ?? 7);
  if (isNaN(days) || days < 1 || days > 365) {
    set.status = 400;
    return { error: "days must be 1–365" };
  }

  const buckets = makeBuckets(days);
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir).filter((d) => {
      try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    set.status = 500;
    return { error: "Cannot read ~/.claude/projects/" };
  }

  // agentName → { costs: number[], hadActivity: boolean[] }
  const agentDailyMap = new Map<string, { costs: number[]; hadActivity: boolean[] }>();

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    if (files.length === 0) continue;
    const agentName = agentNameFromDir(dir);

    if (!agentDailyMap.has(agentName)) {
      agentDailyMap.set(agentName, {
        costs: Array(days).fill(0),
        hadActivity: Array(days).fill(false),
      });
    }

    const entry = agentDailyMap.get(agentName)!;

    for (const file of files) {
      const usage = scanSession(join(dirPath, file));
      if (!usage || !usage.lastTimestamp) continue;

      const dateStr = localDateStr(usage.lastTimestamp);
      const idx = bucketIndex.get(dateStr);
      if (idx === undefined) continue; // outside the window

      entry.costs[idx] += estimateCost(usage);
      entry.hadActivity[idx] = true;
    }
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

costsApi.get("/costs", ({ set }) => {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir).filter((d) => {
      try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    set.status = 500; return { error: "Cannot read ~/.claude/projects/" };
  }

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

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    if (files.length === 0) continue;
    const agentName = agentNameFromDir(dir);

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

    for (const file of files) {
      const usage = scanSession(join(dirPath, file));
      if (!usage) continue;

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
